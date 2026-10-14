// Deterministic metadata cleaning pipeline.
//
// PORTED FROM Echo Music v1.4.2/v1.4.3 (EchoMusicApp/Echo-Music), module
// `:metadata` — `com.music.echo.metadata.cleaner.MetadataCleaner` +
// `CleanerRules` + `models/*`. The v1.4.2 release notes describe it as
// "a deterministic metadata cleaning pipeline (#550)": song titles and artist
// names are cleaned consistently, which improves lyrics matching, while band
// names containing ampersands and conjunctions are preserved.
//
// WHY SOUNDWAVE NEEDS IT
// ----------------------
// Provider pages and YouTube hand back titles like
// "Alan Walker - Faded (Official Music Video) [4K]" and channels like
// "Coldplay - Topic" / "TaylorSwiftVEVO". Every downstream matcher — LRCLIB
// lyrics, KuGou lyrics, similar-song ranking, mirror recovery, YouTube →
// provider matching — used to invent its own partial cleanup, so each one
// failed differently. One pipeline, applied everywhere, replaces that.
//
// The five stages, in order, exactly as upstream:
//   1. Unicode + entity sanitisation
//   2. "Artist - Title" prefix extraction
//   3. Bracket / pipe / hashtag tag extraction (junk vs version vs featuring)
//   4. Channel-junk scrubbing on the artist ("- Topic", "VEVO", " Records")
//   5. Multi-artist delimiter split → primary artist + featured artists

/** Version kinds, mirroring upstream's `VersionType` enum. */
export const VERSION_TYPE = Object.freeze({
  ORIGINAL: 'ORIGINAL',
  REMIX: 'REMIX',
  LIVE: 'LIVE',
  ACOUSTIC: 'ACOUSTIC',
  REMASTER: 'REMASTER',
  INSTRUMENTAL: 'INSTRUMENTAL',
  COVER: 'COVER',
  EDIT: 'EDIT',
  EXTENDED: 'EXTENDED',
  RADIO_EDIT: 'RADIO_EDIT',
  SLOWED: 'SLOWED',
  SPED_UP: 'SPED_UP',
  OTHER_VERSION: 'OTHER_VERSION',
});

// Video/quality noise that carries no musical meaning.
const JUNK_WORDS = 'official\\s+music\\s+video|official\\s+video|official\\s+audio|music\\s+video|lyric\\s+video|lyrics\\s+video|official\\s+visualizer|visualizer|video|audio|mv|pv|hd|hq|4k|1080p|720p|60fps|uhd';

/** `CleanerRules` — every pattern upstream keeps in one object. */
export const CLEANER_RULES = Object.freeze({
  JUNK_PATTERNS: [
    new RegExp(`\\s*\\(.*?\\b(?:${JUNK_WORDS})\\b.*?\\)`, 'i'),
    new RegExp(`\\s*\\[.*?\\b(?:${JUNK_WORDS})\\b.*?\\]`, 'i'),
    /\s*【.*?\b(?:official|mv|pv|video|audio|lyrics)\b.*?】/i,
    /\s*「.*?\b(?:official|mv|pv|video|audio|lyrics)\b.*?」/i,
    /\s*\|.*$/,
    /\s*\/\/.*$/,
    /\s*#\w+/,
    /\s*-\s*(?:official|video|audio|lyrics|lyric|visualizer).*$/i,
  ],
  FEATURING_PATTERNS: [
    /\s*\(feat\.?\s+([^()]+)\)/i,
    /\s*\(ft\.?\s+([^()]+)\)/i,
    /\s*\[feat\.?\s+([^\[\]]+)\]/i,
    /\s*\[ft\.?\s+([^\[\]]+)\]/i,
    /\s*\b(?:feat\.?|ft\.?|featuring)\s+([^()\[\]\-|]+)/i,
  ],
  // Order matters: the first pattern that matches a bracket wins, so
  // "remix" beats "live" beats "acoustic", exactly like upstream.
  VERSION_PATTERNS: [
    [/\b(?:remix|flip|bootleg|vip|re-edit|club mix|dub)\b/i, VERSION_TYPE.REMIX],
    [/\b(?:live|session|unplugged|in concert|live at [a-zA-Z0-9\s]+)\b/i, VERSION_TYPE.LIVE],
    [/\b(?:acoustic|orchestral|symphonic)\b/i, VERSION_TYPE.ACOUSTIC],
    [/\b(?:remaster|remastered|deluxe|anniversary)\b/i, VERSION_TYPE.REMASTER],
    [/\b(?:instrumental|karaoke)\b/i, VERSION_TYPE.INSTRUMENTAL],
    [/\b(?:cover)\b/i, VERSION_TYPE.COVER],
    [/\b(?:radio edit|edit)\b/i, VERSION_TYPE.RADIO_EDIT],
    [/\b(?:extended|extended mix)\b/i, VERSION_TYPE.EXTENDED],
    [/\b(?:slowed|slowed \+ reverb|reverb)\b/i, VERSION_TYPE.SLOWED],
    [/\b(?:sped up|nightcore)\b/i, VERSION_TYPE.SPED_UP],
  ],
  ARTIST_SEPARATORS: [' & ', ', ', ' feat. ', ' feat ', ' ft. ', ' ft ', ' featuring ', ' and ', ' x ', ' X '],
  CHANNEL_JUNK_SUFFIXES: [
    /\s*-\s*Topic$/i,
    /VEVO$/i,
    /\s+Records$/i,
    /\s+Official$/i,
  ],
  // Bare junk phrases, for the "Artist - <junk>" guard in stage 2.
  BARE_JUNK: new RegExp(`^(?:${JUNK_WORDS})$`, 'i'),
});

/** Kotlin's `Regex.matches()` is a FULL match; JS needs anchors. */
const fullMatch = (re, s) => new RegExp(`^(?:${re.source})$`, re.flags.replace('g', '')).test(s);
const containsMatch = (re, s) => new RegExp(re.source, re.flags.replace('g', '')).test(s);
/** Kotlin's `replaceFirst(literal, " ")` — literal, first occurrence only. */
const replaceFirstLiteral = (s, literal, withStr = ' ') => {
  const i = s.indexOf(literal);
  return i < 0 ? s : s.slice(0, i) + withStr + s.slice(i + literal.length);
};

// Stage 1 ---------------------------------------------------------------
// HTML entities, smart quotes, emoji/other-symbol noise. `\p{Cn}` drops
// unassigned code points, which some providers emit inside artwork-scraped
// titles.
const SMART_SINGLE = /[\u2018\u2019\u00b4`]/g;
const SMART_DOUBLE = /[\u201c\u201d]/g;
const SYMBOL_NOISE = /[\p{So}\p{Cn}]/gu;
function sanitizeUnicode(input) {
  return String(input ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(SMART_SINGLE, "'")
    .replace(SMART_DOUBLE, '"')
    .replace(SYMBOL_NOISE, '')
    .trim();
}

// Stage 5 (used by stages 2 and 3 too) ----------------------------------
function splitArtists(artistString) {
  const s = String(artistString ?? '');
  if (!s.trim()) return { primary: '', others: [] };
  let tokens = [s];
  for (const sep of CLEANER_RULES.ARTIST_SEPARATORS) {
    const next = [];
    for (const t of tokens) next.push(...t.split(sep));
    tokens = next;
  }
  const cleaned = tokens.map((t) => t.trim()).filter(Boolean);
  if (!cleaned.length) return { primary: '', others: [] };
  return { primary: cleaned[0], others: cleaned.slice(1) };
}

// Stage 3 ---------------------------------------------------------------
const BRACKET_RE = /(\(([^()]*)\)|\[([^\[\]]*)\]|【([^【】]*)】|「([^「」]*)」)/g;
const PIPE_RE = /\s*(?:\||\/\/)\s*(.*)$/;
const HASHTAG_RE = /\s*#\w+/g;
const INLINE_FEAT_RE = /(?:\s+|^)(?:feat\.?|ft\.?|featuring)\s+([^()\[\]\-|]+)/i;
const FEAT_CONTENT_RE = /^(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;
const PIPE_JUNK_WORDS = /\b(?:official|video|visualizer|audio|mv|pv|lyrics?|remaster|hd|4k)\b/i;

function extractTagsAndVersions(title) {
  let working = String(title ?? '');
  const junkTags = [];
  const featuredArtists = [];
  let version = null;

  // Pipe / double-slash trailing junk: "Song | Official Visualizer 2024".
  const pipe = working.match(PIPE_RE);
  if (pipe) {
    const trailing = (pipe[1] || '').trim();
    const isJunk = CLEANER_RULES.JUNK_PATTERNS.some((re) => containsMatch(re, trailing))
      || containsMatch(PIPE_JUNK_WORDS, trailing);
    if (isJunk) {
      junkTags.push(trailing);
      working = working.slice(0, pipe.index).trim();
    }
  }

  // Hashtags (#shorts, #trending) are junk, not part of the title.
  for (const m of working.matchAll(HASHTAG_RE)) junkTags.push(m[0].trim());
  working = working.replace(HASHTAG_RE, '').trim();

  // Bracketed expressions: featuring, version, or junk — in that priority.
  const matches = [...working.matchAll(BRACKET_RE)];
  for (const m of matches) {
    const full = m[0];
    const content = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim();

    const feat = content.match(FEAT_CONTENT_RE);
    if (feat) {
      const parts = splitArtists((feat[1] || '').trim());
      if (parts.primary) featuredArtists.push(parts.primary);
      featuredArtists.push(...parts.others);
      working = replaceFirstLiteral(working, full);
      continue;
    }

    let matchedVersion = null;
    for (const [pattern, type] of CLEANER_RULES.VERSION_PATTERNS) {
      if (containsMatch(pattern, content)) { matchedVersion = { type, description: content }; break; }
    }
    if (matchedVersion) {
      if (!version) version = matchedVersion;
      working = replaceFirstLiteral(working, full);
      continue;
    }

    const isJunk = CLEANER_RULES.JUNK_PATTERNS.some((re) => containsMatch(re, full) || containsMatch(re, content));
    if (isJunk) {
      junkTags.push(content || full);
      working = replaceFirstLiteral(working, full);
    }
  }

  // Inline featuring with no brackets: "Lean On feat. MØ".
  const inline = working.match(INLINE_FEAT_RE);
  if (inline) {
    const parts = splitArtists((inline[1] || '').trim());
    if (parts.primary) featuredArtists.push(parts.primary);
    featuredArtists.push(...parts.others);
    working = (working.slice(0, inline.index) + working.slice(inline.index + inline[0].length)).trim();
  }

  return { cleanedTitle: working.trim(), junkTags, featuredArtists, version };
}

// Stage 2 ---------------------------------------------------------------
function splitArtistTitle(title, artist) {
  const parts = String(title ?? '').split(/\s+-\s+/);
  if (parts.length >= 2) {
    const potentialArtist = parts[0].trim();
    const potentialTitle = parts.slice(1).join(' - ').trim();
    if (potentialTitle) {
      const extracted = extractTagsAndVersions(potentialTitle);
      const isRightSideVersionOrJunk = /^[([【「]/.test(potentialTitle)
        || !extracted.cleanedTitle
        || CLEANER_RULES.VERSION_PATTERNS.some(([re]) => fullMatch(re, potentialTitle))
        || CLEANER_RULES.JUNK_PATTERNS.some((re) => fullMatch(re, potentialTitle))
        || CLEANER_RULES.BARE_JUNK.test(potentialTitle);

      if (!isRightSideVersionOrJunk) {
        if (artist && artist.trim()) {
          const a = artist.toLowerCase();
          const pa = potentialArtist.toLowerCase();
          if (pa.includes(a) || a.includes(pa) || a.includes('topic') || a.includes('vevo')) {
            return { title: potentialTitle, artist: potentialArtist };
          }
        } else {
          // No artist at all: both sides look like real names ("Artist - Title").
          return { title: potentialTitle, artist: potentialArtist };
        }
      }
    }
  }
  return { title, artist };
}

// Stage 4 ---------------------------------------------------------------
const splitCamelCase = (text) => {
  if (/\s/.test(text)) return text;
  const chars = [...text];
  if (chars.every((c) => c === c.toUpperCase()) || chars.every((c) => c === c.toLowerCase())) return text;
  return text.replace(/(?<=[a-z])(?=[A-Z])/g, ' ');
};
const ciEndsWith = (s, suffix) => s.toLowerCase().endsWith(suffix.toLowerCase());

function scrubChannelJunk(artist) {
  let c = String(artist ?? '').trim();
  if (ciEndsWith(c, '- Topic')) c = c.slice(0, -7).trim();
  else if (ciEndsWith(c, ' - Topic')) c = c.slice(0, -8).trim();

  if (ciEndsWith(c, 'VEVO')) c = splitCamelCase(c.slice(0, -4).trim());

  if (ciEndsWith(c, ' Records')) c = c.replace(/\s+records$/i, '').trim();
  else if (ciEndsWith(c, ' Official')) c = c.replace(/\s+official$/i, '').trim();

  return c.trim();
}

function normalizeTitle(title) {
  return String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-\u2013\u2014|/]+$/, '')
    .trim();
}

/**
 * Runs the full five-stage pipeline.
 *
 * @param {string} rawTitle
 * @param {string} [rawArtist]
 * @returns {{
 *   rawTitle: string, rawArtist: string, cleanTitle: string,
 *   primaryArtist: string, cleanArtist: string, featuredArtists: string[],
 *   version: {type: string, description: string} | null, junkTags: string[]
 * }}
 */
export function cleanMetadata(rawTitle, rawArtist = '') {
  const junkTags = [];
  const featuredArtists = [];

  // Stage 1
  let currentTitle = sanitizeUnicode(rawTitle);
  let currentArtist = sanitizeUnicode(rawArtist);

  // Stage 2
  const split = splitArtistTitle(currentTitle, currentArtist);
  currentTitle = split.title;
  if (String(split.artist ?? '').trim()) currentArtist = split.artist;

  // Stage 3
  const extraction = extractTagsAndVersions(currentTitle);
  currentTitle = extraction.cleanedTitle;
  junkTags.push(...extraction.junkTags);
  const detectedVersion = extraction.version;
  featuredArtists.push(...extraction.featuredArtists);

  // Stage 4
  currentArtist = scrubChannelJunk(currentArtist);

  // Stage 5
  const artistSplit = splitArtists(currentArtist);
  const primaryArtist = artistSplit.primary;
  featuredArtists.push(...artistSplit.others);

  currentTitle = normalizeTitle(currentTitle);

  return {
    rawTitle: String(rawTitle ?? ''),
    rawArtist: String(rawArtist ?? ''),
    cleanTitle: currentTitle,
    primaryArtist,
    // cleanArtist keeps ampersands and conjunctions: "Simon & Garfunkel" and
    // "Earth, Wind & Fire" must survive as searchable band names.
    cleanArtist: currentArtist || primaryArtist,
    featuredArtists: [...new Set(featuredArtists)]
      .filter((n) => n && n.trim() && n.toLowerCase() !== primaryArtist.toLowerCase()),
    version: detectedVersion,
    junkTags,
  };
}

/** "Crawl Outta Love (The Glitch Mob Remix)" — the version is kept for display. */
export function displayTitle(meta) {
  const clean = String(meta?.cleanTitle || meta?.rawTitle || '').trim();
  const v = meta?.version;
  return v && v.type !== VERSION_TYPE.ORIGINAL && v.description ? `${clean} (${v.description})` : clean;
}

/** `[cleanTitle, cleanArtist]` — what upstream feeds to search/lyrics lookups. */
export function searchQuery(meta) {
  return [String(meta?.cleanTitle || ''), String(meta?.cleanArtist || meta?.primaryArtist || '')];
}

/**
 * Upstream's `trackKeyOf`: whitespace-trimmed, lowercased "title|artist".
 * Deliberately NOT cleaned — play statistics must key on what the user saw.
 */
export function trackKeyOf(title, artist) {
  return `${String(title ?? '').trim()}|${String(artist ?? '').trim()}`.toLowerCase();
}

/**
 * Accent-folding used across the server's matching code (`fold` in server.js).
 * Duplicated here so this module stays import-free and unit-testable.
 */
const foldKey = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Key for "never recommend again" (Echo v1.4.2).
 *
 * This is a wire contract: the client's `excludeKey` in services/taste.js must
 * produce byte-identical output for the same title/artist, or exclusions
 * silently stop matching. Both sides are pinned by tests.
 */
export function excludeKey(title, artist) {
  return foldKey(`${String(title ?? '').trim()}|${String(artist ?? '').trim()}`).replace(/[^a-z0-9|]/g, '');
}

/**
 * Query-side helper: the cleaned text worth searching for, or the original
 * when cleaning would empty it (a query of "[4K]" alone must still search).
 *
 * The two halves are re-joined in the order the user typed them. Stage 2 always
 * reads "Left - Right" as artist-title, so a pasted provider title
 * ("Laembadgini - Diljit Dosanjh") comes back with the halves swapped; putting
 * the primary artist first restores the original reading and keeps the query
 * sane either way.
 */
export function cleanQuery(q) {
  const raw = String(q ?? '').trim();
  if (!raw) return raw;
  const m = cleanMetadata(raw, '');
  // Nothing to remove (no junk, no version, no split): leave the query alone.
  if (!m.junkTags.length && !m.version && m.cleanTitle === raw && m.cleanArtist === raw) return raw;
  const cleaned = `${m.primaryArtist} ${m.cleanTitle}`
    .replace(/\s*[|/]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || raw;
}
