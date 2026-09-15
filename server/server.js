import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' });
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const LASTFM_KEY = process.env.LASTFM_API_KEY || '';
const AUDIODB_KEY = process.env.AUDIODB_API_KEY || '2'; // '2' = free test key

// JioSaavn mirrors — tried in order, first healthy one wins (full 320kbps tracks)
const SAAVN_BASES = [
  process.env.JIOSAAVN_API_URL,
  'https://saavn.dev/api',
  'https://saavn.sumit.co/api',
].filter(Boolean).map(u => u.replace(/\/$/, ''));

const DEEZER = 'https://api.deezer.com';
const ITUNES = 'https://itunes.apple.com';
const COUNTRY = process.env.ITUNES_COUNTRY || 'IN';

app.use(cors());
app.use(express.json());

// ---------- tiny in-memory cache ----------
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 10;
function getCache(k) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL) { cache.delete(k); return null; }
  return hit.v;
}
function setCache(k, v) {
  if (cache.size > 800) cache.clear();
  cache.set(k, { t: Date.now(), v });
}

async function fetchJson(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': 'SoundWave/1.0', Accept: 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON from ${url}: ${text.slice(0, 80)}`);
    }
  } finally { clearTimeout(t); }
}

// Saavn with mirror failover + short negative caching
const baseCooldown = new Map();
async function saavnFetch(path) {
  for (const base of SAAVN_BASES) {
    if ((baseCooldown.get(base) || 0) > Date.now()) continue;
    try {
      return await fetchJson(`${base}${path}`, {}, 8000);
    } catch (e) {
      baseCooldown.set(base, Date.now() + 60000);
    }
  }
  throw new Error('All JioSaavn mirrors unreachable');
}

// ---------- normalizers → unified schema ----------
function pickImage(images, quality = 'large') {
  if (!images) return '';
  if (typeof images === 'string') return images;
  if (Array.isArray(images)) {
    const order = quality === 'small' ? ['50x50', '150x150', '500x500'] : quality === 'medium' ? ['150x150', '500x500', '50x50'] : ['500x500', '150x150', '50x50'];
    for (const q of order) { const f = images.find(i => i.quality === q || i.link?.includes(q)); if (f) return f.url || f.link; }
    return images[images.length - 1]?.url || images[images.length - 1]?.link || '';
  }
  return images[quality] || images.large || '';
}
const itunesArt = (url, size = 600) => (url || '').replace('100x100bb', `${size}x${size}bb`).replace('100x100', `${size}x${size}`);

function streamsFromSaavn(downloadUrl = []) {
  const get = (q) => downloadUrl.find(d => d.quality === q)?.url || null;
  const high = get('320kbps') || get('160kbps') || get('96kbps') || get('48kbps') || null;
  const medium = get('160kbps') || get('96kbps') || high;
  const low = get('96kbps') || get('48kbps') || medium;
  return { low, medium, high };
}

function normalizeSaavnSong(s) {
  if (!s || !s.id) return null;
  const artists = s.artists?.primary || s.artists?.all || [];
  const streams = streamsFromSaavn(s.downloadUrl || []);
  return {
    id: `saavn:${s.id}`, source: 'saavn', sourceId: String(s.id),
    title: s.name || 'Unknown',
    artist: { id: artists[0]?.id ? `saavn:ar:${artists[0].id}` : '', name: artists[0]?.name || s.primaryArtists || 'Unknown Artist', image: pickImage(artists[0]?.image, 'medium') },
    artists: artists.map(a => ({ id: `saavn:ar:${a.id}`, name: a.name, image: pickImage(a.image, 'small') })),
    album: { id: s.album?.id ? `saavn:al:${s.album.id}` : '', name: s.album?.name || 'Unknown Album', image: pickImage(s.image, 'large'), year: s.year || s.releaseDate?.slice(0, 4) || '' },
    duration: Number(s.duration) || 0,
    streamUrl: streams.high || streams.medium || streams.low || '', streams,
    previewUrl: streams.low || '', image: pickImage(s.image, 'large'),
    thumbnails: { small: pickImage(s.image, 'small'), medium: pickImage(s.image, 'medium'), large: pickImage(s.image, 'large') },
    language: s.language || '', playCount: Number(s.playCount) || 0,
    explicit: s.explicitContent === true || s.explicitContent === 'true',
    hasLyrics: !!s.hasLyrics, lyricsId: s.lyricsId || s.id, genre: [], url: s.url || '',
    isPreview: false, isLiked: false,
  };
}

function normalizeDeezerTrack(t) {
  if (!t || !t.id) return null;
  return {
    id: `deezer:${t.id}`, source: 'deezer', sourceId: String(t.id),
    title: t.title || 'Unknown',
    artist: { id: `deezer:ar:${t.artist?.id}`, name: t.artist?.name || 'Unknown Artist', image: t.artist?.picture_medium || t.artist?.picture || '' },
    artists: t.contributors?.map(c => ({ id: `deezer:ar:${c.id}`, name: c.name, image: c.picture_small || '' })) || [],
    album: { id: `deezer:al:${t.album?.id}`, name: t.album?.title || 'Unknown Album', image: t.album?.cover_xl || t.album?.cover_big || t.album?.cover || '', year: '' },
    duration: Number(t.duration) || 30,
    streamUrl: t.preview || '', streams: { low: t.preview || '', medium: t.preview || '', high: t.preview || '' },
    previewUrl: t.preview || '', image: t.album?.cover_xl || t.album?.cover_big || '',
    thumbnails: { small: t.album?.cover_small || '', medium: t.album?.cover_medium || '', large: t.album?.cover_xl || t.album?.cover_big || '' },
    language: '', playCount: Number(t.rank) || 0, explicit: !!t.explicit_lyrics,
    hasLyrics: false, lyricsId: null, genre: [], url: t.link || '',
    isPreview: true, isLiked: false,
  };
}

function normalizeItunesSong(t) {
  if (!t || (!t.trackId && !t.collectionId)) return null;
  const art = itunesArt(t.artworkUrl100, 600);
  return {
    id: `itunes:${t.trackId}`, source: 'itunes', sourceId: String(t.trackId),
    title: t.trackName || 'Unknown',
    artist: { id: `itunes:ar:${t.artistId}`, name: t.artistName || 'Unknown Artist', image: itunesArt(t.artworkUrl100, 300) },
    artists: [{ id: `itunes:ar:${t.artistId}`, name: t.artistName || 'Unknown Artist', image: '' }],
    album: { id: `itunes:al:${t.collectionId}`, name: t.collectionName || 'Unknown Album', image: art, year: (t.releaseDate || '').slice(0, 4) },
    duration: Math.round((Number(t.trackTimeMillis) || 30000) / 1000),
    streamUrl: t.previewUrl || '', streams: { low: t.previewUrl || '', medium: t.previewUrl || '', high: t.previewUrl || '' },
    previewUrl: t.previewUrl || '', image: art,
    thumbnails: { small: itunesArt(t.artworkUrl100, 100), medium: itunesArt(t.artworkUrl100, 300), large: art },
    language: '', playCount: 0, explicit: t.trackExplicitness === 'explicit',
    hasLyrics: false, lyricsId: null, genre: t.primaryGenreName ? [t.primaryGenreName] : [],
    url: t.trackViewUrl || '', isPreview: true, isLiked: false,
  };
}

function normalizeSaavnAlbum(a) {
  if (!a || !a.id) return null;
  return {
    id: `saavn:al:${a.id}`, source: 'saavn', sourceId: String(a.id), type: 'album',
    name: a.name || a.title || 'Unknown Album',
    artist: a.primaryArtists || a.artists?.primary?.[0]?.name || 'Various Artists',
    image: pickImage(a.image, 'large'),
    thumbnails: { small: pickImage(a.image, 'small'), medium: pickImage(a.image, 'medium'), large: pickImage(a.image, 'large') },
    year: a.year || '', songCount: a.songCount || a.songs?.length || 0,
  };
}
function normalizeItunesAlbum(t) {
  const id = t.collectionId;
  if (!id) return null;
  return {
    id: `itunes:al:${id}`, source: 'itunes', sourceId: String(id), type: 'album',
    name: t.collectionName || 'Unknown Album', artist: t.artistName || 'Various Artists',
    image: itunesArt(t.artworkUrl100, 600),
    thumbnails: { small: itunesArt(t.artworkUrl100, 100), medium: itunesArt(t.artworkUrl100, 300), large: itunesArt(t.artworkUrl100, 600) },
    year: (t.releaseDate || '').slice(0, 4), songCount: Number(t.trackCount) || 0,
  };
}
function normalizeDeezerAlbum(a) {
  if (!a || !a.id) return null;
  return {
    id: `deezer:al:${a.id}`, source: 'deezer', sourceId: String(a.id), type: 'album',
    name: a.title || 'Unknown Album', artist: a.artist?.name || 'Various Artists',
    image: a.cover_xl || a.cover_big || a.cover || '',
    thumbnails: { small: a.cover_small || '', medium: a.cover_medium || '', large: a.cover_xl || a.cover_big || '' },
    year: a.release_date?.slice(0, 4) || '', songCount: a.nb_tracks || 0,
  };
}
function normalizeSaavnArtist(a) {
  if (!a || !a.id) return null;
  return {
    id: `saavn:ar:${a.id}`, source: 'saavn', sourceId: String(a.id), type: 'artist',
    name: a.name || 'Unknown Artist', image: pickImage(a.image, 'large'),
    thumbnails: { small: pickImage(a.image, 'small'), medium: pickImage(a.image, 'medium'), large: pickImage(a.image, 'large') }, role: a.role || '',
  };
}
function normalizeItunesArtist(t) {
  if (!t || !t.artistId) return null;
  return {
    id: `itunes:ar:${t.artistId}`, source: 'itunes', sourceId: String(t.artistId), type: 'artist',
    name: t.artistName || 'Unknown Artist', image: itunesArt(t.artworkUrl100, 600),
    thumbnails: { small: itunesArt(t.artworkUrl100, 100), medium: itunesArt(t.artworkUrl100, 300), large: itunesArt(t.artworkUrl100, 600) }, role: t.primaryGenreName || '',
  };
}
function normalizeDeezerArtist(a) {
  if (!a || !a.id) return null;
  return {
    id: `deezer:ar:${a.id}`, source: 'deezer', sourceId: String(a.id), type: 'artist',
    name: a.name || 'Unknown Artist', image: a.picture_xl || a.picture_big || a.picture_medium || '',
    thumbnails: { small: a.picture_small || '', medium: a.picture_medium || '', large: a.picture_xl || a.picture_big || '' }, role: '',
  };
}
function normalizeSaavnPlaylist(p) {
  if (!p || !p.id) return null;
  return {
    id: `saavn:pl:${p.id}`, source: 'saavn', sourceId: String(p.id), type: 'playlist',
    name: p.name || p.title || 'Untitled Playlist', description: p.description || '',
    image: pickImage(p.image, 'large'),
    thumbnails: { small: pickImage(p.image, 'small'), medium: pickImage(p.image, 'medium'), large: pickImage(p.image, 'large') },
    songCount: p.songCount || p.songs?.length || 0,
  };
}

function dedupe(tracks) {
  const seen = new Set();
  return (tracks || []).filter(t => {
    if (!t || !t.id) return false;
    const key = `${(t.title || '').toLowerCase().trim()}|${(t.artist?.name || '').toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- upstream helpers ----------
async function saavnSearchSongs(query, limit = 20) {
  const j = await saavnFetch(`/search/songs?query=${encodeURIComponent(query)}&limit=${limit}`);
  const arr = j?.data?.results || j?.data || [];
  return (Array.isArray(arr) ? arr : []).map(normalizeSaavnSong).filter(Boolean);
}
async function saavnSearchAlbums(query, limit = 12) {
  const j = await saavnFetch(`/search/albums?query=${encodeURIComponent(query)}&limit=${limit}`);
  const arr = j?.data?.results || j?.data || [];
  return (Array.isArray(arr) ? arr : []).map(normalizeSaavnAlbum).filter(Boolean);
}
async function saavnSearchArtists(query, limit = 12) {
  const j = await saavnFetch(`/search/artists?query=${encodeURIComponent(query)}&limit=${limit}`);
  const arr = j?.data?.results || j?.data || [];
  return (Array.isArray(arr) ? arr : []).map(normalizeSaavnArtist).filter(Boolean);
}
async function saavnSearchPlaylists(query, limit = 12) {
  const j = await saavnFetch(`/search/playlists?query=${encodeURIComponent(query)}&limit=${limit}`);
  const arr = j?.data?.results || j?.data || [];
  return (Array.isArray(arr) ? arr : []).map(normalizeSaavnPlaylist).filter(Boolean);
}
async function deezerSearchTracks(query, limit = 20) {
  const j = await fetchJson(`${DEEZER}/search?q=${encodeURIComponent(query)}&limit=${limit}`, {}, 8000);
  return (j?.data || []).map(normalizeDeezerTrack).filter(Boolean);
}
async function itunesSearchSongs(query, limit = 20, country = COUNTRY) {
  const j = await fetchJson(`${ITUNES}/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit}&country=${country}`, {}, 8000);
  return (j?.results || []).map(normalizeItunesSong).filter(t => t && t.streamUrl);
}
async function itunesSearchAlbums(query, limit = 12, country = COUNTRY) {
  const j = await fetchJson(`${ITUNES}/search?term=${encodeURIComponent(query)}&media=music&entity=album&limit=${limit}&country=${country}`, {}, 8000);
  const seen = new Set();
  return (j?.results || []).map(normalizeItunesAlbum).filter(a => a && !seen.has(a.id) && (seen.add(a.id), true));
}
async function itunesSearchArtists(query, limit = 12, country = COUNTRY) {
  const j = await fetchJson(`${ITUNES}/search?term=${encodeURIComponent(query)}&media=music&entity=musicArtist&limit=${limit}&country=${country}`, {}, 8000);
  // artist entity has no artwork — enrich with a song search for images
  const artists = (j?.results || []).filter(a => a.artistId);
  const withArt = await Promise.allSettled(artists.slice(0, limit).map(async (a) => {
    let img = '';
    try {
      const s = await fetchJson(`${ITUNES}/search?term=${encodeURIComponent(a.artistName)}&media=music&entity=song&limit=1&country=${country}`, {}, 6000);
      img = itunesArt(s?.results?.[0]?.artworkUrl100, 600);
    } catch {}
    return { id: `itunes:ar:${a.artistId}`, source: 'itunes', sourceId: String(a.artistId), type: 'artist', name: a.artistName, image: img, thumbnails: { small: img, medium: img, large: img }, role: a.primaryGenreName || '' };
  }));
  return withArt.filter(s => s.status === 'fulfilled').map(s => s.value);
}
async function itunesLookup(ids, entity = 'song') {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).join(',');
  if (!list) return [];
  const j = await fetchJson(`${ITUNES}/lookup?id=${list}&entity=${entity}&limit=200&country=${COUNTRY}`, {}, 10000);
  return j?.results || [];
}
async function itunesTopSongs(country = COUNTRY, limit = 25) {
  const rss = await fetchJson(`${ITUNES}/${country.toLowerCase()}/rss/topsongs/limit=${limit}/json`, {}, 8000);
  const entries = rss?.feed?.entry || [];
  const ids = entries.map(e => e?.id?.attributes?.['im:id']).filter(Boolean);
  if (!ids.length) return [];
  const looked = await itunesLookup(ids, 'song');
  const byId = new Map(looked.filter(r => r.trackId).map(r => [String(r.trackId), r]));
  // preserve chart order; fall back to RSS metadata when lookup misses
  return ids.map((id, i) => {
    const hit = byId.get(String(id));
    if (hit) return { ...normalizeItunesSong(hit), chartRank: i + 1 };
    const e = entries[i];
    const imgs = e?.['im:image'] || [];
    const img = (imgs[2] || imgs[1] || imgs[0])?.label || '';
    return {
      id: `itunes:${id}`, source: 'itunes', sourceId: String(id), title: e?.['im:name']?.label || 'Unknown',
      artist: { id: '', name: e?.['im:artist']?.label || 'Unknown', image: img },
      artists: [], album: { id: '', name: '', image: img, year: '' }, duration: 30,
      streamUrl: '', streams: {}, previewUrl: '', image: img,
      thumbnails: { small: img, medium: img, large: img }, genre: [], isPreview: true, chartRank: i + 1,
    };
  }).filter(t => t.streamUrl || t.previewUrl);
}
async function itunesTopAlbums(country = COUNTRY, limit = 12) {
  const rss = await fetchJson(`${ITUNES}/${country.toLowerCase()}/rss/topalbums/limit=${limit}/json`, {}, 8000);
  return (rss?.feed?.entry || []).map(e => {
    const id = e?.id?.attributes?.['im:id'];
    const imgs = e?.['im:image'] || [];
    const img = (imgs[2] || imgs[1] || imgs[0])?.label || '';
    const hi = img.replace('170x170bb', '600x600bb');
    return { id: `itunes:al:${id}`, source: 'itunes', sourceId: String(id), type: 'album', name: e?.['im:name']?.label || 'Unknown', artist: e?.['im:artist']?.label || '', image: hi, thumbnails: { small: img, medium: img, large: hi }, year: (e?.['im:releaseDate']?.label || '').slice(0, 4), songCount: 0 };
  }).filter(a => a.sourceId && a.sourceId !== 'undefined');
}
async function audioDbArtist(name) {
  try {
    const j = await fetchJson(`https://www.theaudiodb.com/api/v1/json/${AUDIODB_KEY}/search.php?s=${encodeURIComponent(name)}`, {}, 8000);
    return j?.artists?.[0] || null;
  } catch { return null; }
}

// ---------- Audius (full indie tracks, no key) ----------
const AUDIUS_DNS = [
  'https://discoveryprovider.audius.co',
  'https://discoveryprovider2.audius.co',
  'https://discoveryprovider3.audius.co',
];
async function audiusFetch(path) {
  let lastErr;
  for (const base of AUDIUS_DNS) {
    try {
      const sep = path.includes('?') ? '&' : '?';
      return await fetchJson(`${base}${path}${sep}app_name=SoundWave`, {}, 9000);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Audius unreachable');
}
function normalizeAudiusTrack(t) {
  if (!t || !t.id) return null;
  const art = t.artwork || {};
  const img = art['1000x1000'] || art['480x480'] || art['150x150'] || '';
  const uimg = t.user?.profile_picture?.['480x480'] || t.user?.profile_picture?.['150x150'] || '';
  return {
    id: `audius:${t.id}`, source: 'audius', sourceId: String(t.id),
    title: t.title || 'Unknown',
    artist: { id: `audius:ar:${t.user?.id || t.user?.handle || ''}`, name: t.user?.name || t.user?.handle || 'Unknown Artist', image: uimg },
    artists: [],
    album: { id: '', name: '', image: img, year: (t.release_date || '').slice(0, 4) },
    duration: Number(t.duration) || 0,
    streamUrl: `${AUDIUS_DNS[0]}/v1/tracks/${t.id}/stream?app_name=SoundWave`,
    streams: null, previewUrl: '', image: img,
    thumbnails: { small: art['150x150'] || img, medium: art['480x480'] || img, large: img },
    language: '', playCount: Number(t.play_count) || 0, explicit: false,
    hasLyrics: false, lyricsId: null, genre: t.genre ? [t.genre] : [],
    url: t.permalink ? `https://audius.co${t.permalink}` : '',
    isPreview: false, isLiked: false,
  };
}
async function audiusTrending(limit = 15, genre = '') {
  const j = await audiusFetch(`/v1/tracks/trending?limit=${limit}${genre ? `&genre=${encodeURIComponent(genre)}` : ''}`);
  return (j?.data || []).map(normalizeAudiusTrack).filter(t => t && t.streamUrl);
}
async function audiusSearch(query, limit = 10) {
  const j = await audiusFetch(`/v1/tracks/search?query=${encodeURIComponent(query)}&limit=${limit}`);
  return (j?.data || []).map(normalizeAudiusTrack).filter(t => t && t.streamUrl);
}

// ---------- Internet Archive (full tracks, no key, best-effort) ----------
function parseArchiveDuration(d) {
  if (d == null) return 0;
  if (/^\d+(\.\d+)?$/.test(String(d).trim())) return Math.round(Number(d));
  const parts = String(d).split(':').map(Number);
  if (!parts.length || parts.some(isNaN)) return 0;
  return parts.reduce((a, b) => a * 60 + b, 0);
}
async function archiveSearch(query, limit = 6) {
  const q = `(${query}) AND mediatype:audio`;
  const j = await fetchJson(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=duration&rows=${limit}&output=json`, {}, 12000);
  const docs = j?.response?.docs || [];
  const out = [];
  for (const d of docs.slice(0, limit)) {
    try {
      const meta = await fetchJson(`https://archive.org/metadata/${d.identifier}`, {}, 10000);
      const files = (meta?.files || []).filter(f => /\.mp3$/i.test(f.name || ''));
      const pick = files.find(f => !/_vbr|_64kb|_128kb/i.test(f.name)) || files[0];
      if (!pick) continue;
      const sid = d.identifier;
      out.push({
        id: `archive:${sid}`, source: 'archive', sourceId: sid,
        title: d.title || meta?.metadata?.title || sid,
        artist: { id: '', name: d.creator || meta?.metadata?.creator || 'Archive.org', image: '' },
        artists: [],
        album: { id: '', name: '', image: `https://archive.org/services/img/${sid}`, year: '' },
        duration: parseArchiveDuration(d.duration || meta?.metadata?.duration),
        streamUrl: `https://archive.org/download/${sid}/${encodeURIComponent(pick.name).replace(/%2F/g, '/')}`,
        streams: null, previewUrl: '', image: `https://archive.org/services/img/${sid}`,
        thumbnails: { small: '', medium: '', large: '' },
        language: '', playCount: 0, explicit: false,
        hasLyrics: false, lyricsId: null, genre: [],
        url: `https://archive.org/details/${sid}`,
        isPreview: false, isLiked: false,
      });
    } catch { /* skip failed items */ }
  }
  return out;
}

// ---------- Radio Browser (live stations, no key) ----------
const RADIO_HOSTS = ['https://de1.api.radio-browser.info', 'https://de2.api.radio-browser.info'];
async function radioFetch(path) {
  let lastErr;
  for (const h of RADIO_HOSTS) {
    try { return await fetchJson(`${h}${path}`, { headers: { 'User-Agent': 'SoundWave/1.0' } }, 9000); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Radio Browser unreachable');
}
function normalizeStation(s) {
  const url = s.url_resolved || s.url;
  if (!s.stationuuid || !url || !/^https?:\/\//.test(url)) return null;
  return {
    id: `radio:${s.stationuuid}`, source: 'radio', sourceId: s.stationuuid,
    title: (s.name || 'Unknown Station').trim(),
    artist: { id: '', name: [s.country, (s.tags || '').split(',').slice(0, 2).join(' · ')].filter(Boolean).join(' · ') || 'Live Radio', image: s.favicon || '' },
    artists: [],
    album: { id: '', name: 'Live Radio', image: s.favicon || '', year: '' },
    duration: 0, streamUrl: url, streams: null, previewUrl: '',
    image: s.favicon || '', thumbnails: { small: '', medium: '', large: '' },
    language: s.language || '', playCount: Number(s.votes) || 0, explicit: false,
    hasLyrics: false, lyricsId: null,
    genre: (s.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 3),
    url: s.homepage || '', isPreview: false, isLive: true, isLiked: false,
    codec: s.codec || '', bitrate: Number(s.bitrate) || 0,
  };
}

// ---------- routes ----------
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'soundwave', time: new Date().toISOString() }));

app.get('/api/sources', async (req, res) => {
  const probes = {
    saavn: (async () => { await saavnFetch('/search/songs?query=test&limit=1'); return 'ok'; })(),
    itunes: fetchJson(`${ITUNES}/search?term=test&media=music&limit=1`, {}, 8000).then(() => 'ok'),
    deezer: fetchJson(`${DEEZER}/search?q=test&limit=1`, {}, 8000).then(() => 'ok'),
    lyrics: fetchJson('https://api.lyrics.ovh/v1/Coldplay/Yellow', {}, 8000).then(() => 'ok'),
    audiodb: fetchJson(`https://www.theaudiodb.com/api/v1/json/${AUDIODB_KEY}/search.php?s=coldplay`, {}, 8000).then(() => 'ok'),
    audius: audiusFetch('/v1/tracks/trending?limit=1').then(() => 'ok'),
    archive: fetchJson('https://archive.org/advancedsearch.php?q=test&fl[]=identifier&rows=1&output=json', {}, 10000).then(() => 'ok'),
    radio: radioFetch('/json/stations/topvote/1').then(() => 'ok'),
    ytplayer: fetch('https://www.youtube.com/iframe_api', { headers: { 'User-Agent': 'SoundWave/1.0' }, signal: AbortSignal.timeout(8000) }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return 'ok'; }),
    mono: monoFetch('/search/?s=test').then(() => 'ok'),
  };
  const out = {};
  await Promise.all(Object.entries(probes).map(async ([k, p]) => {
    try { out[k] = await p; } catch (e) { out[k] = `down: ${e.message.slice(0, 80)}`; }
  }));
  res.json(out);
});

app.get('/api/home', async (req, res) => {
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const [trendingSaavn, chartsIN, chartsUS, newAlbums, topSongsUS, chill, workout, playlists, deezerChart] = await Promise.allSettled([
      saavnSearchSongs('trending hindi hits 2026', 20),
      itunesTopSongs('IN', 25),
      itunesTopSongs('US', 15),
      itunesTopAlbums('IN', 12),
      itunesSearchSongs('top global hits 2026', 12, 'US'),
      itunesSearchSongs('chill lofi vibes', 15),
      itunesSearchSongs('workout energetic pump', 15),
      saavnSearchPlaylists('bollywood hits', 10),
      fetchJson(`${DEEZER}/chart/0/tracks?limit=15`, {}, 8000).then(j => (j?.data || []).map(normalizeDeezerTrack).filter(Boolean)),
    ]);
    const V = (r) => (r.status === 'fulfilled' ? r.value : []);
    const charts = dedupe([...V(chartsIN), ...V(chartsUS)]);
    const trendingNow = dedupe([...V(trendingSaavn), ...V(chartsIN).slice(0, 12), ...V(topSongsUS)]);
    const artistMap = new Map();
    [...V(chartsIN), ...V(chartsUS)].forEach(t => {
      const a = t.artist;
      if (a?.id && !artistMap.has(a.id)) artistMap.set(a.id, { id: a.id, source: t.source, sourceId: a.id.split(':').pop(), type: 'artist', name: a.name, image: t.image, thumbnails: t.thumbnails, role: '' });
    });
    const payload = {
      hero: trendingNow.slice(0, 5),
      trendingNow: trendingNow.slice(0, 18),
      charts: [...charts, ...V(deezerChart)].slice(0, 25),
      newReleases: V(newAlbums),
      topArtists: [...artistMap.values()].slice(0, 14),
      mood: { chill: V(chill), workout: V(workout) },
      featuredPlaylists: V(playlists),
    };
    setCache(req.originalUrl, payload);
    res.json(payload);
  } catch (e) {
    console.error('home error', e.message);
    res.status(502).json({ error: 'Failed to load home feed', detail: e.message });
  }
});

// ---------------- Monochrome API (Tidal catalog: search + Hi-Res DASH previews) ----------------
const MONO_API = (process.env.MONO_API_URL || 'https://monochrome-api.samidy.com').replace(/\/$/, '');
async function monoFetch(path, timeout = 20000) {
  const r = await fetch(`${MONO_API}${path}`, { headers: { 'User-Agent': 'SoundWave/1.0' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`Mono HTTP ${r.status} for ${path}`);
  return r.json();
}
function tidalImg(uuid, size = 640) {
  if (!uuid) return '';
  return `https://resources.tidal.com/images/${String(uuid).replace(/-/g, '/')}/${size}x${size}.jpg`;
}
function normalizeMonoTrack(t) {
  if (!t?.id) return null;
  const artists = (t.artists || (t.artist ? [t.artist] : [])).filter(Boolean);
  const a0 = artists[0] || {};
  const alb = t.album || {};
  return {
    id: `mono:${t.id}`, source: 'mono', sourceId: String(t.id), type: 'track',
    title: t.title || 'Unknown',
    artist: { id: a0.id ? `mono:ar:${a0.id}` : '', name: a0.name || 'Unknown', image: tidalImg(a0.picture, 320) },
    artists: artists.map(a => ({ id: a.id ? `mono:ar:${a.id}` : '', name: a.name || '', image: tidalImg(a.picture, 320) })),
    album: { id: alb.id ? `mono:al:${alb.id}` : '', name: alb.title || '', image: tidalImg(alb.cover, 640), year: (alb.releaseDate || '').slice(0, 4) },
    duration: t.duration || 30, image: tidalImg(alb.cover, 640),
    streamUrl: `/api/mono-audio?id=${t.id}`, previewUrl: `/api/mono-audio?id=${t.id}`,
    isPreview: true, codec: 'flac', explicit: !!t.explicit,
    popularity: t.popularity || 0, isrc: t.isrc || '', playCount: 0,
  };
}
function normalizeMonoArtist(a) {
  if (!a?.id) return null;
  return { id: `mono:ar:${a.id}`, source: 'mono', sourceId: String(a.id), type: 'artist', name: a.name || 'Unknown', image: tidalImg(a.picture, 640) || (a.selectedAlbumCoverFallback ? tidalImg(a.selectedAlbumCoverFallback, 640) : ''), popularity: a.popularity || 0 };
}
function normalizeMonoAlbum(al) {
  if (!al?.id) return null;
  const a0 = (al.artists || [])[0] || {};
  return { id: `mono:al:${al.id}`, source: 'mono', sourceId: String(al.id), type: 'album', name: al.title || 'Album', artist: a0.name || '', image: tidalImg(al.cover, 640), year: (al.releaseDate || '').slice(0, 4), trackCount: al.numberOfTracks || 0 };
}
function normalizeMonoPlaylist(pl) {
  const pid = pl.uuid || pl.id;
  if (!pid) return null;
  return { id: `mono:pl:${pid}`, source: 'mono', sourceId: String(pid), type: 'playlist', name: pl.title || 'Playlist', description: pl.description || '', image: pl.squareImage ? tidalImg(pl.squareImage, 640) : '', trackCount: pl.numberOfTracks || 0 };
}
async function monoSearchSongs(q, limit = 10) {
  const j = await monoFetch(`/search/?s=${encodeURIComponent(q)}`);
  return (j?.data?.items || []).slice(0, limit).map(normalizeMonoTrack).filter(Boolean);
}
async function monoSearchArtists(q, limit = 8) {
  const j = await monoFetch(`/search/?a=${encodeURIComponent(q)}`);
  return (j?.data?.artists?.items || []).slice(0, limit).map(normalizeMonoArtist).filter(Boolean);
}
async function monoSearchAlbums(q, limit = 8) {
  const j = await monoFetch(`/search/?al=${encodeURIComponent(q)}`);
  return (j?.data?.albums?.items || []).slice(0, limit).map(normalizeMonoAlbum).filter(Boolean);
}
async function monoSearchPlaylists(q, limit = 6) {
  const j = await monoFetch(`/search/?p=${encodeURIComponent(q)}`);
  return (j?.data?.playlists?.items || []).slice(0, limit).map(normalizeMonoPlaylist).filter(Boolean);
}
// Stitched DASH preview cache: id -> { buf, time }
const monoAudioCache = new Map();
async function monoStitchedAudio(id) {
  const hit = monoAudioCache.get(String(id));
  if (hit && Date.now() - hit.time < 15 * 60 * 1000) return hit.buf;
  const j = await monoFetch(`/track/?id=${encodeURIComponent(id)}`, 30000);
  const b64 = j?.data?.manifest;
  if (!b64) throw new Error(j?.detail || 'No manifest');
  const xml = Buffer.from(b64, 'base64').toString('utf8');
  const tpl = xml.match(/<SegmentTemplate[^>]*>/)?.[0] || '';
  const init = (tpl.match(/initialization="([^"]+)"/)?.[1] || '').replace(/&amp;/g, '&');
  const media = (tpl.match(/media="([^"]+)"/)?.[1] || '').replace(/&amp;/g, '&');
  if (!init || !media || !media.includes('$Number$')) throw new Error('Unsupported manifest');
  let count = 0;
  for (const m of xml.matchAll(/<S\b[^>]*>/g)) {
    const tag = m[0];
    const r = parseInt(tag.match(/\br="(\d+)"/)?.[1] || '0', 10);
    count += r + 1;
  }
  if (!count || count > 60) throw new Error('Bad segment timeline');
  const urls = [init, ...Array.from({ length: count }, (_, i) => media.replace('$Number$', String(i + 1)))];
  const parts = new Array(urls.length);
  let next = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (next < urls.length) {
      const i = next++;
      const r = await fetch(urls[i], { headers: { 'User-Agent': 'SoundWave/1.0' }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) throw new Error(`Segment ${i} HTTP ${r.status}`);
      parts[i] = Buffer.from(await r.arrayBuffer());
    }
  });
  await Promise.all(workers);
  const buf = Buffer.concat(parts);
  if (buf.length < 10000) throw new Error('Stitched audio too small');
  if (monoAudioCache.size > 4) monoAudioCache.delete(monoAudioCache.keys().next().value);
  monoAudioCache.set(String(id), { buf, time: Date.now() });
  return buf;
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const type = (req.query.type || 'all').toLowerCase();
  if (!q) return res.json({ songs: [], albums: [], artists: [], playlists: [] });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    let songs = [], albums = [], artists = [], playlists = [];
    if (type === 'all' || type === 'songs') {
      const [a, b, c, d, e] = await Promise.allSettled([saavnSearchSongs(q, 20), audiusSearch(q, 8), monoSearchSongs(q, 10), itunesSearchSongs(q, 20), deezerSearchTracks(q, 12)]);
      // order = quality priority: full tracks first, then HI-RES previews, then standard previews
      songs = dedupe([...(a.status === 'fulfilled' ? a.value : []), ...(b.status === 'fulfilled' ? b.value : []), ...(c.status === 'fulfilled' ? c.value : []), ...(d.status === 'fulfilled' ? d.value : []), ...(e.status === 'fulfilled' ? e.value : [])]);
    }
    if (type === 'all' || type === 'albums') {
      const [a, b, e] = await Promise.allSettled([saavnSearchAlbums(q, 10), itunesSearchAlbums(q, 10), monoSearchAlbums(q, 8)]);
      albums = [...(a.status === 'fulfilled' ? a.value : []), ...(b.status === 'fulfilled' ? b.value : []), ...(e.status === 'fulfilled' ? e.value : [])];
    }
    if (type === 'all' || type === 'artists') {
      const [a, b, e] = await Promise.allSettled([saavnSearchArtists(q, 8), itunesSearchArtists(q, 8), monoSearchArtists(q, 8)]);
      artists = [...(a.status === 'fulfilled' ? a.value : []), ...(b.status === 'fulfilled' ? b.value : []), ...(e.status === 'fulfilled' ? e.value : [])];
    }
    if (type === 'all' || type === 'playlists') {
      const [a, e] = await Promise.allSettled([saavnSearchPlaylists(q, 10), monoSearchPlaylists(q, 6)]);
      playlists = [...(a.status === 'fulfilled' ? a.value : []), ...(e.status === 'fulfilled' ? e.value : [])];
    }
    const payload = { songs, albums, artists, playlists };
    setCache(req.originalUrl, payload);
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: 'Search failed', detail: e.message });
  }
});

app.get('/api/song/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    if (source === 'saavn') {
      const j = await saavnFetch(`/songs/${encodeURIComponent(id)}`);
      const track = normalizeSaavnSong(j?.data?.[0] || j?.data);
      if (!track) return res.status(404).json({ error: 'Song not found' });
      if (!track.streamUrl) {
        const fb = await itunesSearchSongs(`${track.title} ${track.artist?.name}`, 3).catch(() => []);
        if (fb[0]?.streamUrl) { track.previewUrl = fb[0].streamUrl; track.streamUrl = fb[0].streamUrl; track.fallbackSource = 'itunes'; }
      }
      setCache(req.originalUrl, track);
      return res.json(track);
    }
    if (source === 'deezer') {
      const track = normalizeDeezerTrack(await fetchJson(`${DEEZER}/track/${encodeURIComponent(id)}`));
      if (!track) return res.status(404).json({ error: 'Song not found' });
      setCache(req.originalUrl, track);
      return res.json(track);
    }
    if (source === 'itunes') {
      const results = await itunesLookup(id, 'song');
      const track = normalizeItunesSong(results.find(r => r.trackId) || results[0]);
      if (!track) return res.status(404).json({ error: 'Song not found' });
      setCache(req.originalUrl, track);
      return res.json(track);
    }
    if (source === 'mono') {
      const j = await monoFetch(`/info/?id=${encodeURIComponent(id)}`);
      const track = normalizeMonoTrack(j?.data);
      if (!track) return res.status(404).json({ error: 'Song not found' });
      setCache(req.originalUrl, track);
      return res.json(track);
    }
    res.status(400).json({ error: 'Unknown source' });
  } catch (e) { res.status(502).json({ error: 'Failed to resolve song', detail: e.message }); }
});

app.get('/api/album/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    if (source === 'saavn') {
      const j = await saavnFetch(`/albums/${encodeURIComponent(id)}`);
      const d = j?.data || {};
      const payload = { ...normalizeSaavnAlbum(d), description: d.description || '', songs: (d.songs || []).map(normalizeSaavnSong).filter(Boolean) };
      setCache(req.originalUrl, payload);
      return res.json(payload);
    }
    if (source === 'itunes') {
      const results = await itunesLookup(id, 'song');
      const col = results.find(r => r.wrapperType === 'collection') || {};
      const songs = results.filter(r => r.wrapperType === 'track').map(normalizeItunesSong).filter(t => t && t.streamUrl);
      const payload = { ...(normalizeItunesAlbum({ collectionId: id, collectionName: col.collectionName, artistName: col.artistName, artworkUrl100: col.artworkUrl100, releaseDate: col.releaseDate, trackCount: col.trackCount }) || { id: `itunes:al:${id}`, name: col.collectionName || 'Album', image: itunesArt(col.artworkUrl100, 600) }), description: '', songs };
      setCache(req.originalUrl, payload);
      return res.json(payload);
    }
    if (source === 'deezer') {
      const j = await fetchJson(`${DEEZER}/album/${encodeURIComponent(id)}`);
      const songs = (j?.tracks?.data || []).map(t => normalizeDeezerTrack({ ...t, artist: t.artist || j.artist, album: { id: j.id, title: j.title, cover_xl: j.cover_xl, cover_big: j.cover_big } })).filter(Boolean);
      const payload = { ...normalizeDeezerAlbum(j), description: '', songs };
      setCache(req.originalUrl, payload);
      return res.json(payload);
    }
    if (source === 'mono') {
      const j = await monoFetch(`/album/?id=${encodeURIComponent(id)}&limit=100`);
      const d = j?.data || {};
      const songs = (d.items || []).map(x => normalizeMonoTrack(x?.item)).filter(Boolean);
      const payload = { ...normalizeMonoAlbum(d), description: d.copyright || '', songs };
      if (!payload.artist && songs[0]) payload.artist = songs[0].artist?.name || '';
      if (!payload.image && songs[0]) payload.image = songs[0].image || '';
      setCache(req.originalUrl, payload);
      return res.json(payload);
    }
    res.status(400).json({ error: 'Unknown source' });
  } catch (e) { res.status(502).json({ error: 'Failed to load album', detail: e.message }); }
});

app.get('/api/artist/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    let payload = null;
    if (source === 'saavn') {
      const j = await saavnFetch(`/artists/${encodeURIComponent(id)}`);
      const d = j?.data || {};
      payload = {
        ...normalizeSaavnArtist(d), bio: d.bio || '',
        topSongs: (d.topSongs || []).map(normalizeSaavnSong).filter(Boolean),
        topAlbums: (d.topAlbums || []).map(normalizeSaavnAlbum).filter(Boolean),
        similar: (d.similarArtists || []).map(normalizeSaavnArtist).filter(Boolean),
      };
    } else if (source === 'itunes') {
      const [songsRes, albumsRes] = await Promise.all([
        fetchJson(`${ITUNES}/lookup?id=${encodeURIComponent(id)}&entity=song&limit=25&sort=popularity&country=${COUNTRY}`, {}, 10000).catch(() => ({ results: [] })),
        fetchJson(`${ITUNES}/lookup?id=${encodeURIComponent(id)}&entity=album&limit=12&country=${COUNTRY}`, {}, 10000).catch(() => ({ results: [] })),
      ]);
      const songsAll = songsRes?.results || [];
      const artistMeta = songsAll.find(r => r.wrapperType === 'artist') || (albumsRes?.results || []).find(r => r.wrapperType === 'artist') || {};
      const topSongs = songsAll.filter(r => r.wrapperType === 'track').map(normalizeItunesSong).filter(t => t && t.streamUrl);
      payload = {
        id: `itunes:ar:${id}`, source: 'itunes', sourceId: String(id), type: 'artist',
        name: artistMeta.artistName || topSongs[0]?.artist?.name || 'Artist',
        image: topSongs[0]?.image || '', bio: '',
        topSongs,
        topAlbums: (albumsRes?.results || []).filter(r => r.wrapperType === 'collection').map(normalizeItunesAlbum).filter(Boolean),
        similar: [],
      };
    } else if (source === 'deezer') {
      const [a, top] = await Promise.all([
        fetchJson(`${DEEZER}/artist/${encodeURIComponent(id)}`),
        fetchJson(`${DEEZER}/artist/${encodeURIComponent(id)}/top?limit=10`).catch(() => ({ data: [] })),
      ]);
      payload = { ...normalizeDeezerArtist(a), bio: '', topSongs: (top?.data || []).map(normalizeDeezerTrack).filter(Boolean), topAlbums: [], similar: [] };
    } else if (source === 'mono') {
      const j = await monoFetch(`/artist/?id=${encodeURIComponent(id)}`);
      const a = j?.artist || {};
      const [top, sim] = await Promise.all([
        monoSearchSongs(a.name || id, 10).catch(() => []),
        monoFetch(`/artist/similar/?id=${encodeURIComponent(id)}`).catch(() => null),
      ]);
      const simItems = sim?.artists?.items || sim?.data?.artists?.items || (Array.isArray(sim?.data) ? sim.data : []) || [];
      payload = {
        ...normalizeMonoArtist(a), bio: '',
        topSongs: top, topAlbums: [],
        similar: simItems.map(normalizeMonoArtist).filter(Boolean).slice(0, 8),
      };
    } else return res.status(400).json({ error: 'Unknown source' });

    // Enrichment: AudioDB (free) + LastFM (optional key)
    if (payload?.name) {
      const adb = await audioDbArtist(payload.name);
      if (adb) {
        payload.bio = payload.bio || adb.strBiographyEN || '';
        payload.image = payload.image || adb.strArtistThumb || adb.strArtistFanart || '';
        payload.fanart = adb.strArtistFanart || '';
        payload.formedYear = adb.intFormedYear || '';
        payload.genre = adb.strGenre || '';
      }
      if (LASTFM_KEY) {
        try {
          const lf = await fetchJson(`https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(payload.name)}&api_key=${LASTFM_KEY}&format=json`, {}, 8000);
          const info = lf?.artist;
          if (info) {
            payload.bio = payload.bio || (info.bio?.summary || '').replace(/<[^>]*>/g, '');
            if (!payload.similar?.length && info.similar?.artist) {
              payload.similar = info.similar.artist.slice(0, 8).map(x => ({ id: `lastfm:ar:${x.name}`, source: 'lastfm', sourceId: x.name, type: 'artist', name: x.name, image: x.image?.[3]?.['#text'] || '' }));
            }
            payload.tags = (info.tags?.tag || []).map(t => t.name);
          }
        } catch {}
      }
    }
    setCache(req.originalUrl, payload);
    res.json(payload);
  } catch (e) { res.status(502).json({ error: 'Failed to load artist', detail: e.message }); }
});

app.get('/api/playlist/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    if (source === 'saavn') {
      const j = await saavnFetch(`/playlists/${encodeURIComponent(id)}`);
      const d = j?.data || {};
      const payload = { ...normalizeSaavnPlaylist(d), description: d.description || '', songs: (d.songs || []).map(normalizeSaavnSong).filter(Boolean) };
      setCache(req.originalUrl, payload);
      return res.json(payload);
    }
    if (source === 'deezer') {
      const j = await fetchJson(`${DEEZER}/playlist/${encodeURIComponent(id)}`);
      const payload = {
        id: `deezer:pl:${j.id}`, source: 'deezer', sourceId: String(j.id), type: 'playlist',
        name: j.title, description: j.description || '', image: j.picture_xl || j.picture_big || '',
        songs: (j?.tracks?.data || []).map(normalizeDeezerTrack).filter(Boolean),
      };
      setCache(req.originalUrl, payload);
      return res.json(payload);
    }
    if (source === 'mono') {
      const j = await monoFetch(`/playlist/?id=${encodeURIComponent(id)}&limit=100`);
      const d = j?.data || j?.playlist || {};
      const items = d.items || d.tracks?.items || [];
      const songs = items.map(x => normalizeMonoTrack(x?.item || x)).filter(Boolean);
      const payload = { ...normalizeMonoPlaylist({ uuid: id, title: d.title, description: d.description, numberOfTracks: d.numberOfTracks, squareImage: d.squareImage }), description: d.description || '', image: songs[0]?.image || '', songs };
      setCache(req.originalUrl, payload);
      return res.json(payload);
    }
    if (source === 'archive') {
      const meta = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(id)}`, {}, 20000);
      const files = (meta?.files || []).filter(f => /\.(mp3|ogg|flac|m4a)$/i.test(f.name || '') && !/_(vbr|64kb|meta|thumbs|itemimage)/i.test(f.name || ''));
      const mp3s = files.filter(f => /\.mp3$/i.test(f.name));
      const list = (mp3s.length ? mp3s : files).slice(0, 200);
      const md = meta?.metadata || {};
      const thumb = `https://archive.org/download/${id}/__ia_thumb.jpg`;
      const songs = list.map((f, i) => ({
        id: `archive:${id}:${i}`, source: 'archive', sourceId: `${id}/${f.name}`, type: 'track',
        title: (f.title || f.name || '').replace(/\.[^.]+$/, '').replace(/[_+]/g, ' ').trim() || `Track ${i + 1}`,
        artist: { id: '', name: md.creator || 'Unknown' }, artists: [],
        album: { id: `archive:pl:${id}`, name: md.title || 'Live concert', image: thumb },
        duration: parseArchiveDuration(f.length) || 0, image: thumb,
        streamUrl: `https://archive.org/download/${id}/${encodeURIComponent(f.name)}`,
        isPreview: false, codec: (String(f.name).split('.').pop() || '').toLowerCase(),
      }));
      const cname = `${md.creator || ''} — ${md.coverage || md.date || ''}`.trim() || md.title || 'Concert';
      const payload = { id: `archive:pl:${id}`, source: 'archive', sourceId: id, type: 'playlist', name: cname, description: String(md.description || '').slice(0, 500), image: thumb, songs };
      setCache(req.originalUrl, payload);
      return res.json(payload);
    }
    res.status(400).json({ error: 'Unknown source' });
  } catch (e) { res.status(502).json({ error: 'Failed to load playlist', detail: e.message }); }
});

app.get('/api/charts', async (req, res) => {
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const [inSongs, usSongs, inAlbums, dz] = await Promise.allSettled([
      itunesTopSongs('IN', 25), itunesTopSongs('US', 15), itunesTopAlbums('IN', 12),
      fetchJson(`${DEEZER}/chart/0/tracks?limit=15`, {}, 8000).then(j => (j?.data || []).map(normalizeDeezerTrack).filter(Boolean)),
    ]);
    const V = (r) => (r.status === 'fulfilled' ? r.value : []);
    const tracks = dedupe([...V(inSongs), ...V(dz), ...V(usSongs)]);
    const artistMap = new Map();
    V(inSongs).forEach(t => { if (t.artist?.id && !artistMap.has(t.artist.id)) artistMap.set(t.artist.id, { id: t.artist.id, source: t.source, sourceId: t.artist.id.split(':').pop(), type: 'artist', name: t.artist.name, image: t.image, thumbnails: t.thumbnails, role: '' }); });
    const payload = { tracks, albums: V(inAlbums), artists: [...artistMap.values()], playlists: [] };
    setCache(req.originalUrl, payload);
    res.json(payload);
  } catch (e) { res.status(502).json({ error: 'Failed to load charts', detail: e.message }); }
});

app.get('/api/radio', async (req, res) => {
  const seed = (req.query.seed || 'top hits').trim();
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const [a, b, c] = await Promise.allSettled([
      itunesSearchSongs(seed, 20), saavnSearchSongs(seed, 15), deezerSearchTracks(seed, 10),
    ]);
    const songs = dedupe([...(b.status === 'fulfilled' ? b.value : []), ...(a.status === 'fulfilled' ? a.value : []), ...(c.status === 'fulfilled' ? c.value : [])]);
    for (let i = songs.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1));[songs[i], songs[k]] = [songs[k], songs[i]]; }
    const payload = { seed, songs };
    setCache(req.originalUrl, payload);
    res.json(payload);
  } catch (e) { res.status(502).json({ error: 'Radio failed', detail: e.message }); }
});

// Full-track sources: Audius trending, live radio, alternates matcher
app.get('/api/underground', async (req, res) => {
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const tracks = await audiusTrending(15, req.query.genre || '');
    setCache(req.originalUrl, tracks);
    res.json(tracks);
  } catch (e) { res.status(502).json({ error: 'Underground feed failed', detail: e.message }); }
});

const BUILTIN_STATIONS = [
  { stationuuid: 'somafm-groovesalad', name: 'SomaFM: Groove Salad', url_resolved: 'https://ice1.somafm.com/groovesalad-128-mp3', favicon: 'https://somafm.com/img/groovesalad.jpg', tags: 'ambient,beats', country: 'USA', language: 'English', votes: 9999, homepage: 'https://somafm.com/groovesalad/' },
  { stationuuid: 'somafm-defcon', name: 'SomaFM: DEF CON Radio', url_resolved: 'https://ice1.somafm.com/defcon-128-mp3', favicon: 'https://somafm.com/img/defcon.jpg', tags: 'hacker,electronic', country: 'USA', language: 'English', votes: 9998, homepage: 'https://somafm.com/defcon/' },
  { stationuuid: 'somafm-dronezone', name: 'SomaFM: Drone Zone', url_resolved: 'https://ice1.somafm.com/dronezone-128-mp3', favicon: 'https://somafm.com/img/dronezone.jpg', tags: 'ambient,drone', country: 'USA', language: 'English', votes: 9997, homepage: 'https://somafm.com/dronezone/' },
  { stationuuid: 'somafm-fluid', name: 'SomaFM: Fluid', url_resolved: 'https://ice1.somafm.com/fluid-128-mp3', favicon: 'https://somafm.com/img/fluid.jpg', tags: 'hiphop,chill', country: 'USA', language: 'English', votes: 9996, homepage: 'https://somafm.com/fluid/' },
  { stationuuid: 'somafm-7soul', name: 'SomaFM: Seven Inch Soul', url_resolved: 'https://ice1.somafm.com/7soul-128-mp3', favicon: 'https://somafm.com/img/7soul.jpg', tags: 'soul,funk', country: 'USA', language: 'English', votes: 9995, homepage: 'https://somafm.com/7soul/' },
  { stationuuid: 'somafm-metal', name: 'SomaFM: Metal Detector', url_resolved: 'https://ice1.somafm.com/metal-128-mp3', favicon: 'https://somafm.com/img/metal.jpg', tags: 'metal', country: 'USA', language: 'English', votes: 9994, homepage: 'https://somafm.com/metal/' },
];
app.get('/api/radio-stations', async (req, res) => {
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const { tag, country, name } = req.query;
    let path = '/json/stations/topvote/24';
    if (name) path = `/json/stations/search?name=${encodeURIComponent(name)}&limit=20`;
    else if (tag) path = `/json/stations/bytag/${encodeURIComponent(tag)}?limit=20`;
    else if (country) path = `/json/stations/bycountry/${encodeURIComponent(country)}?limit=20`;
    const j = await radioFetch(path);
    const stations = (Array.isArray(j) ? j : []).map(normalizeStation).filter(Boolean).slice(0, 24);
    setCache(req.originalUrl, stations);
    res.json(stations);
  } catch (e) {
    const fb = BUILTIN_STATIONS.map(normalizeStation).filter(Boolean);
    if (fb.length) { setCache(req.originalUrl, fb); return res.json(fb); }
    res.status(502).json({ error: 'Radio stations failed', detail: e.message });
  }
});

function similarityScore(a, b) {
  const words = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(w => { if (B.has(w)) inter++; });
  return inter / Math.max(A.size, B.size);
}

app.get('/api/alternates', async (req, res) => {
  const title = (req.query.title || '').trim();
  const artist = (req.query.artist || '').trim();
  if (!title) return res.json({ track: null });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const q = `${title} ${artist}`.trim();
    const [au, ar] = await Promise.allSettled([audiusSearch(q, 8), archiveSearch(q, 4)]);
    const cands = [...(au.status === 'fulfilled' ? au.value : []), ...(ar.status === 'fulfilled' ? ar.value : [])];
    let best = null, bestScore = 0;
    for (const c of cands) {
      const s = similarityScore(`${title} ${artist}`, `${c.title} ${c.artist?.name || ''}`);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    const result = bestScore >= 0.4 && best?.streamUrl ? { track: best, score: bestScore } : { track: null, score: bestScore };
    setCache(req.originalUrl, result);
    res.json(result);
  } catch (e) { res.json({ track: null }); }
});

// Monochrome/Tidal Hi-Res preview, stitched from DASH segments into one seekable MP4
app.get('/api/mono-audio', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    const buf = await monoStitchedAudio(id);
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=600');
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      const start = m?.[1] ? parseInt(m[1], 10) : 0;
      const end = m?.[2] ? parseInt(m[2], 10) : buf.length - 1;
      const s = Math.min(start, buf.length - 1), e = Math.min(end, buf.length - 1);
      if (s > e) return res.status(416).end();
      res.status(206);
      res.setHeader('Content-Range', `bytes ${s}-${e}/${buf.length}`);
      res.setHeader('Content-Length', String(e - s + 1));
      return res.end(buf.subarray(s, e + 1));
    }
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  } catch (e) { if (!res.headersSent) res.status(502).json({ error: 'Mono audio failed', detail: e.message }); }
});

// ---------------- Podcasts (iTunes Search, no key + RSS episodes) ----------------
async function itunesPodcastSearch(q, limit = 20) {
  const j = await fetchJson(`${ITUNES}/search?term=${encodeURIComponent(q)}&media=podcast&entity=podcast&limit=${limit}&country=${COUNTRY}`, {}, 12000).catch(() => null);
  return (j?.results || []).map(c => ({
    id: `podcast:${c.collectionId}`, source: 'podcast', type: 'podcast',
    name: c.collectionName || 'Podcast', artist: c.artistName || '',
    image: itunesArt(c.artworkUrl600 || c.artworkUrl100, 600),
    feedUrl: c.feedUrl || '', genres: c.genres || [], trackCount: c.trackCount || 0,
  })).filter(x => x.feedUrl);
}
function decodeEntities(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
}
function stripTags(s) { return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function parseEpDuration(s) {
  if (!s) return 0;
  s = String(s).trim();
  if (/^\d+$/.test(s)) return +s;
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((a, b) => a * 60 + b, 0);
}
function parseRss(xml, feedMeta = {}) {
  const channel = xml.match(/<channel>([\s\S]*?)<\/channel>/)?.[1] || xml;
  const img = channel.match(/<itunes:image[^>]*href="([^"]+)"/)?.[1] || channel.match(/<image>\s*<url>([^<]+)<\/url>/)?.[1] || feedMeta.image || '';
  const episodes = [];
  for (const m of channel.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const enc = it.match(/<enclosure[^>]*url="([^"]+)"/)?.[1] || '';
    if (!enc) continue;
    episodes.push({
      title: stripTags(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] || 'Episode').slice(0, 200),
      pubDate: (it.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] || '').trim(),
      streamUrl: decodeEntities(enc),
      duration: parseEpDuration(it.match(/<(itunes:)?duration>([^<]+)<\/(itunes:)?duration>/)?.[2] || ''),
      description: stripTags(it.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 500),
      image: it.match(/<itunes:image[^>]*href="([^"]+)"/)?.[1] || img,
      guid: stripTags(it.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1] || '').slice(0, 120),
    });
    if (episodes.length >= 60) break;
  }
  return { image: img, episodes };
}
app.get('/api/podcasts/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const out = await itunesPodcastSearch(q, 20);
    setCache(req.originalUrl, out);
    res.json(out);
  } catch (e) { res.status(502).json({ error: 'Podcast search failed', detail: e.message }); }
});
app.get('/api/podcasts/top', async (req, res) => {
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const rss = await fetchJson('https://itunes.apple.com/us/rss/toppodcasts/limit=20/json', {}, 12000);
    const entries = rss?.feed?.entry || [];
    const ids = entries.map(e => e?.id?.attributes?.['im:id']).filter(Boolean).join(',');
    if (!ids) return res.json([]);
    const lookup = await fetchJson(`${ITUNES}/lookup?id=${ids}&entity=podcast&country=${COUNTRY}`, {}, 12000).catch(() => ({ results: [] }));
    const out = (lookup?.results || []).filter(r => r.feedUrl).map(c => ({
      id: `podcast:${c.collectionId}`, source: 'podcast', type: 'podcast',
      name: c.collectionName || 'Podcast', artist: c.artistName || '',
      image: itunesArt(c.artworkUrl600 || c.artworkUrl100, 600),
      feedUrl: c.feedUrl || '', genres: c.genres || [], trackCount: c.trackCount || 0,
    }));
    setCache(req.originalUrl, out);
    res.json(out);
  } catch (e) { res.status(502).json({ error: 'Top podcasts failed', detail: e.message }); }
});
app.get('/api/podcasts/episodes', async (req, res) => {
  const feedUrl = req.query.feedUrl || '';
  if (!/^https?:\/\//.test(feedUrl)) return res.status(400).json({ error: 'Missing feedUrl' });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const r = await fetch(feedUrl, { headers: { 'User-Agent': 'SoundWave/1.0' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Feed HTTP ${r.status}`);
    const xml = await r.text();
    const { image, episodes } = parseRss(xml, { image: req.query.image || '' });
    const show = decodeEntities(req.query.show || '');
    const tracks = episodes.map(ep => ({
      id: `pod:${Buffer.from(ep.streamUrl).toString('base64url').slice(0, 32)}`, source: 'podcast', sourceId: ep.streamUrl, type: 'track',
      title: ep.title, artist: { id: '', name: show || 'Podcast' }, artists: [],
      album: { id: '', name: show || 'Podcast', image }, image,
      duration: ep.duration, streamUrl: ep.streamUrl, isPreview: false,
      pubDate: ep.pubDate, description: ep.description,
    }));
    const out = { image, episodes: tracks };
    setCache(req.originalUrl, out);
    res.json(out);
  } catch (e) { res.status(502).json({ error: 'Episodes failed', detail: e.message }); }
});

// ---------------- Live concerts (Archive.org etree) ----------------
app.get('/api/concerts', async (req, res) => {
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const j = await fetchJson(`https://archive.org/advancedsearch.php?q=${encodeURIComponent('collection:etree AND mediatype:audio')}&fl[]=identifier,title,creator,date,coverage,downloads&rows=14&sort[]=downloads%20desc&output=json`, {}, 15000);
    const items = (j?.response?.docs || []).map(d => ({
      id: `archive:pl:${d.identifier}`, source: 'archive', sourceId: d.identifier, type: 'playlist',
      name: `${d.creator || 'Unknown'} — ${d.coverage || d.date || ''}`.trim() || d.title,
      description: d.title || '', image: `https://archive.org/download/${d.identifier}/__ia_thumb.jpg`,
      trackCount: 0,
    }));
    setCache(req.originalUrl, items);
    res.json(items);
  } catch (e) { res.status(502).json({ error: 'Concerts failed', detail: e.message }); }
});

app.get('/api/lyrics', async (req, res) => {
  const { saavnId, artist, title } = req.query;
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  let result = { lyrics: null, source: null };
  try {
    if (saavnId) {
      const j = await saavnFetch(`/lyrics/${encodeURIComponent(saavnId)}`).catch(() => null);
      const lyr = j?.data?.lyrics;
      if (lyr) result = { lyrics: lyr.replace(/<br\s*\/?>/gi, '\n'), source: 'saavn' };
    }
    if (!result.lyrics && artist && title) {
      const j = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, {}, 10000).catch(() => null);
      if (j?.lyrics) result = { lyrics: j.lyrics, source: 'lyrics.ovh' };
    }
    setCache(req.originalUrl, result);
    res.json(result);
  } catch (e) { res.json(result); }
});

// ---- YouTube player assets (proxied — YouTube serves these WITHOUT CORS
// headers, so browsers can't fetch them directly; required for deciphering) ----
const YT_PLAYER_ID_TTL = 1000 * 60 * 60;
let ytPlayerIdCache = { id: null, t: 0 };
app.get('/api/yt/player-id', async (req, res) => {
  try {
    if (ytPlayerIdCache.id && Date.now() - ytPlayerIdCache.t < YT_PLAYER_ID_TTL) {
      return res.json({ playerId: ytPlayerIdCache.id, cached: true });
    }
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    let r;
    try {
      r = await fetch('https://www.youtube.com/iframe_api', { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    } finally { clearTimeout(to); }
    if (!r.ok) return res.status(502).json({ error: `iframe_api HTTP ${r.status}` });
    const js = await r.text();
    const i = js.indexOf('player\\/');
    if (i < 0) return res.status(502).json({ error: 'player id pattern not found' });
    const id = js.slice(i + 8).split('\\/')[0];
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return res.status(502).json({ error: 'invalid player id' });
    ytPlayerIdCache = { id, t: Date.now() };
    res.json({ playerId: id, cached: false });
  } catch (e) { res.status(502).json({ error: 'player-id fetch failed', detail: e.message }); }
});

const ytJsCache = new Map(); // playerId -> base.js text
app.get('/api/yt/player-js', async (req, res) => {
  const id = String(req.query.id || '');
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(id)) return res.status(400).json({ error: 'bad id' });
  try {
    if (!ytJsCache.has(id)) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 25000);
      let r;
      try {
        r = await fetch(`https://www.youtube.com/s/player/${id}/player_es6.vflset/en_US/base.js`, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      } finally { clearTimeout(to); }
      if (!r.ok) return res.status(502).json({ error: `player js HTTP ${r.status}` });
      const js = await r.text();
      if (js.length < 100000) return res.status(502).json({ error: 'unexpected player js' });
      if (ytJsCache.size > 3) ytJsCache.clear();
      ytJsCache.set(id, js);
    }
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(ytJsCache.get(id));
  } catch (e) { res.status(502).json({ error: 'player-js fetch failed', detail: e.message }); }
});

app.get('/api/stream', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Missing url' });
  try {
    const upstream = await fetch(url, { headers: { 'User-Agent': 'SoundWave/1.0', ...(req.headers.range ? { Range: req.headers.range } : {}) } });
    if (!upstream.ok && upstream.status !== 206) return res.status(502).json({ error: 'Upstream stream failed' });
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(k.toLowerCase())) res.setHeader(k, v);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const reader = upstream.body.getReader();
    req.on('close', () => { try { reader.cancel(); } catch {} });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise(r => res.once('drain', r));
    }
    res.end();
  } catch (e) { if (!res.headersSent) res.status(502).json({ error: 'Stream proxy failed', detail: e.message }); }
});

// Serve production client build (npm run build) from the same process
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../client/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
  console.log('   Serving client build from ../client/dist');
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 SoundWave server on http://localhost:${PORT}`);
  console.log(`   JioSaavn mirrors: ${SAAVN_BASES.join(', ')}`);
  console.log(`   iTunes country: ${COUNTRY} · LastFM: ${LASTFM_KEY ? 'configured' : 'not configured (optional)'}`);
});
