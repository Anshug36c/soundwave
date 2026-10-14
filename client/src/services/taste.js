// Local Taste Engine + crossfade maths — ported from Echo Music v1.4.2/v1.4.3.
//
// SOURCES (EchoMusicApp/Echo-Music, tag v1.4.3)
//   app/.../generate/LocalTasteEngine.kt        weights, scoreStats, time of day,
//                                               candidate filter, seed selection
//   domain/.../usecase/GetQuickPicksUseCase.kt  quick-pick scoring
//   domain/.../usecase/ResolveLocalMixUseCase.kt seed-expanded mix scoring
//   playback/.../crossfade/EqualPowerCurve.kt   constant-power fade curve
//   playback/.../crossfade/AdaptivePreArmManager.kt  adaptive prefetch lead time
//   core/.../db/DatabaseDao.kt (quickPicks / forgottenFavorites)
//                                               per-invocation seeded ordering
//
// Everything here is pure: no store, no DOM, no network — which is why the
// numbers can be unit-tested against upstream's own expectations.
//
// The one deliberate adaptation is `forgottenFavorites`: SoundWave keeps
// aggregate play stats (total ms, skips, last played) rather than Echo's
// per-event rows, so upstream's "0.2 × oldPlayTime > newPlayTime" window test
// becomes "nothing played for N days, but genuinely listened to when it was".

// ---------- LocalTasteEngine weights (verbatim) ----------
export const MAX_SUGGESTIONS = 25;
export const PLAY_WEIGHT = 2.0;
export const SKIP_PENALTY = 3.0;
export const LIKED_BONUS = 5.0;
export const RECENCY_BONUS = 1.5;
export const TIME_OF_DAY_BONUS = 1.3;

const DAY_MS = 86_400_000;
const RECENT_WINDOW_MS = 7 * DAY_MS;
const HISTORY_WINDOW_MS = 30 * DAY_MS;

/** Upstream buckets: 6-11 morning, 12-17 afternoon, 18-21 evening, else night. */
export function currentTimeOfDay(hour = new Date().getHours()) {
  const h = Number(hour);
  if (h >= 6 && h <= 11) return 'morning';
  if (h >= 12 && h <= 17) return 'afternoon';
  if (h >= 18 && h <= 21) return 'evening';
  return 'night';
}

/**
 * Taste score for one track's play statistics.
 *
 * @param {{trackKey?: string, totalPlayTimeMs?: number, skipCount?: number, lastPlayedAtMillis?: number}} stats
 * @param {Set<string>|string[]} likedKeys
 * @param {string} timeOfDay
 * @param {number} [now]
 */
export function scoreStats(stats, likedKeys, timeOfDay, now = Date.now()) {
  const liked = likedKeys instanceof Set ? likedKeys : new Set(likedKeys || []);
  const key = stats?.trackKey || '';
  const totalPlayTimeMs = Math.max(0, Number(stats?.totalPlayTimeMs) || 0);
  const skipCount = Math.max(0, Number(stats?.skipCount) || 0);
  const lastPlayed = Number(stats?.lastPlayedAtMillis) || 0;

  const isLiked = liked.has(key);
  const isRecent = now - lastPlayed < RECENT_WINDOW_MS;

  // Log-normalised play time: the 40th minute of a song counts far less than
  // the first, so one obsessive loop cannot drown out a broad taste profile.
  const playMinutes = totalPlayTimeMs / 60_000;
  const normalizedPlayTime = Math.log(1 + playMinutes);
  let score = normalizedPlayTime * PLAY_WEIGHT;
  score -= skipCount * SKIP_PENALTY;
  if (isLiked) score += LIKED_BONUS;
  if (isRecent) score += RECENCY_BONUS;

  const hourBonus = timeOfDay === 'morning' ? (isRecent ? TIME_OF_DAY_BONUS : 1.0)
    : timeOfDay === 'night' ? (isLiked ? TIME_OF_DAY_BONUS : 1.0)
      : 1.0;
  score *= hourBonus;
  return Math.max(0, score);
}

/** Skipped twice and never really played → not a taste signal at all. */
export function applyCandidateFilter(stats) {
  const skips = Number(stats?.skipCount) || 0;
  const ms = Number(stats?.totalPlayTimeMs) || 0;
  return skips < 2 || ms > 45_000;
}

/** Upstream `trackKeyOf`: trimmed, lowercased "title|artist". Never cleaned. */
export function trackKeyOf(title, artist) {
  return `${String(title ?? '').trim()}|${String(artist ?? '').trim()}`.toLowerCase();
}

/**
 * Key for "never recommend again". Matches the server's `excludeKey` exactly
 * (fold + strip everything but alphanumerics and the separator) so one list
 * works on both sides of the wire.
 */
export function excludeKey(title, artist) {
  return trackKeyOf(title, artist)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9|]/g, '');
}

/**
 * Echo's seed selection: rank the last 30 days of listening, drop exclusions
 * and hard-skipped tracks, take the top `count`.
 *
 * @param {Array} statsList entries shaped like `scoreStats` input (+ title/artist)
 * @param {{likedKeys?: Set<string>|string[], excluded?: Set<string>|string[], timeOfDay?: string, count?: number, now?: number}} opts
 */
export function tasteSeeds(statsList, opts = {}) {
  const {
    likedKeys = new Set(),
    excluded = new Set(),
    timeOfDay = currentTimeOfDay(),
    count = 5,
    now = Date.now(),
  } = opts;
  const liked = likedKeys instanceof Set ? likedKeys : new Set(likedKeys);
  const blocked = excluded instanceof Set ? excluded : new Set(excluded);
  return (statsList || [])
    .filter((s) => s && !blocked.has(s.trackKey) && applyCandidateFilter(s))
    .map((s) => ({ stats: s, score: scoreStats(s, liked, timeOfDay, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, count));
}

/** GetQuickPicksUseCase: +50 for a like, +2 per minute listened (capped at 60). */
export function scoreQuickPick(entry, likedIds) {
  const ids = likedIds instanceof Set ? likedIds : new Set(likedIds || []);
  const likedBonus = ids.has(entry?.id) ? 50.0 : 0.0;
  const listeningSeconds = Math.min((Number(entry?.totalPlayTimeMs) || 0) / 1000, 3600);
  const listeningScore = (listeningSeconds / 60) * 2.0;
  return likedBonus + listeningScore;
}

/** ResolveLocalMixUseCase: shared artist +100, like +30, play minutes up to +60. */
export function scoreLocalMix(candidate, seed, likedIds) {
  const ids = likedIds instanceof Set ? likedIds : new Set(likedIds || []);
  const seedNames = new Set((seed?.artists || [seed?.artist].filter(Boolean))
    .map((a) => String(a?.name ?? a ?? '').trim().toLowerCase()).filter(Boolean));
  const sharesArtist = (candidate?.artists || [candidate?.artist].filter(Boolean))
    .some((a) => seedNames.has(String(a?.name ?? a ?? '').trim().toLowerCase()));
  const artistBonus = sharesArtist ? 100.0 : 0.0;
  const likedBonus = ids.has(candidate?.id) || candidate?.liked ? 30.0 : 0.0;
  const playTimeBonus = Math.min((Number(candidate?.totalPlayTimeMs) || 0) / 60_000, 60.0);
  return artistBonus + likedBonus + playTimeBonus;
}

// ---------- EqualPowerCurve ----------
/**
 * Constant acoustic power: outgoing = cos(t·π/2), incoming = sin(t·π/2), so
 * cos² + sin² = 1 at every point and the centre of the fade does not dip.
 * @param {number} progress 0..1
 */
export function equalPowerGains(progress) {
  const p = Number.isFinite(progress) ? progress : 0;
  const clamped = Math.min(1, Math.max(0, p));
  const angle = clamped * (Math.PI / 2);
  return { outgoingGain: Math.cos(angle), incomingGain: Math.sin(angle) };
}

// ---------- AdaptivePreArmManager ----------
/**
 * Grows the prefetch lead time when tracks take a long time to become playable
 * and shrinks it back when they do not, so a slow network stages the next track
 * earlier instead of missing the handover.
 */
export class AdaptivePreArm {
  constructor(baseLeadTimeMs = 20_000, maxLeadTimeMs = 35_000, slowPrepThresholdMs = 8_000) {
    if (!(baseLeadTimeMs > 0)) throw new Error('baseLeadTimeMs must be positive');
    if (!(slowPrepThresholdMs > 0)) throw new Error('slowPrepThresholdMs must be positive');
    if (!(maxLeadTimeMs >= baseLeadTimeMs)) throw new Error('maxLeadTimeMs must be at least baseLeadTimeMs');
    this.baseLeadTimeMs = baseLeadTimeMs;
    this.maxLeadTimeMs = maxLeadTimeMs;
    this.slowPrepThresholdMs = slowPrepThresholdMs;
    this.currentLeadTimeMs = baseLeadTimeMs;
    this.recentPrepTimes = [];
  }

  recordPreparationDuration(durationMs) {
    const d = Number(durationMs) || 0;
    this.recentPrepTimes.push(d);
    if (this.recentPrepTimes.length > 5) this.recentPrepTimes.shift();

    if (d > this.slowPrepThresholdMs) {
      const expansion = (d - this.slowPrepThresholdMs) * 1.5;
      this.currentLeadTimeMs = Math.min(
        this.maxLeadTimeMs,
        Math.max(this.currentLeadTimeMs, this.baseLeadTimeMs + expansion),
      );
    } else {
      const average = this.recentPrepTimes.reduce((a, b) => a + b, 0) / this.recentPrepTimes.length;
      if (average < this.slowPrepThresholdMs) {
        this.currentLeadTimeMs = Math.max(this.baseLeadTimeMs, this.currentLeadTimeMs - 2_000);
      }
    }
  }

  reset() {
    this.currentLeadTimeMs = this.baseLeadTimeMs;
    this.recentPrepTimes = [];
  }
}

// ---------- per-invocation seeded ordering (Echo v1.4.3) ----------
/** Deterministic 32-bit PRNG. */
export function mulberry32(a) {
  let s = a | 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a → positive 31-bit int; stands in for SQLite's `rowid`. */
export function hashId(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 2147483647;
}

/**
 * A fresh seed per invocation, odd and positive — the JS twin of upstream's
 * `Random.nextInt(1, Int.MAX_VALUE) or 1`.
 */
export function newSeed() {
  return (Math.floor(Math.random() * 1_073_741_823) * 2 + 1) >>> 0;
}

/**
 * Today's seed: stable for 24 h, different tomorrow (the Daily Taste Mix).
 * `base * 2 + 1` keeps it odd like upstream's seed without the collision a
 * plain `base | 1` would cause between two consecutive days.
 */
export function dailySeed(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const base = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  return (base * 2 + 1) >>> 0;
}

/**
 * `ORDER BY ((rowid * :randomSeed) & 2147483647), id`.
 *
 * The v1.4.3 rule this encodes: the ordering is a pure function of (item, seed),
 * so reading the same list twice with one seed cannot reshuffle it mid-render,
 * while a new refresh (new seed) genuinely varies. Never call Math.random() per
 * item inside a selector.
 */
export function seededOrder(items, seed, keyOf = (x) => x?.id ?? x) {
  const list = [...(items || [])];
  const s = (Number(seed) || 1) >>> 0;
  return list
    .map((item) => ({ item, k: String(keyOf(item) ?? ''), r: Math.imul(hashId(keyOf(item)), s) & 2147483647 }))
    .sort((a, b) => (a.r - b.r) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .map((x) => x.item);
}

/**
 * Forgotten Favourites: genuinely-listened tracks that have gone quiet.
 *
 * @param {Array<{id: string, lastPlayedAtMillis?: number, totalPlayTimeMs?: number, skipCount?: number, liked?: boolean}>} entries
 * @param {{now?: number, seed?: number, quietDays?: number, limit?: number}} opts
 */
export function forgottenFavorites(entries, opts = {}) {
  const { now = Date.now(), seed = newSeed(), quietDays = 14, limit = 12 } = opts;
  const quietMs = quietDays * DAY_MS;
  const candidates = (entries || []).filter((e) => {
    if (!e?.id) return false;
    const last = Number(e.lastPlayedAtMillis) || 0;
    if (last && now - last < quietMs) return false;          // still in rotation
    const ms = Number(e.totalPlayTimeMs) || 0;
    return !!e.liked || applyCandidateFilter({ ...e, totalPlayTimeMs: ms });
  });
  return seededOrder(candidates, seed).slice(0, Math.max(0, limit));
}

/** Tracks played inside the last 30 days, newest first (the taste candidate pool). */
export function recentStats(statsList, opts = {}) {
  const { now = Date.now(), windowMs = HISTORY_WINDOW_MS, limit = 100 } = opts;
  return (statsList || [])
    .filter((s) => s && now - (Number(s.lastPlayedAtMillis) || 0) <= windowMs)
    .sort((a, b) => (Number(b.lastPlayedAtMillis) || 0) - (Number(a.lastPlayedAtMillis) || 0))
    .slice(0, Math.max(0, limit));
}
