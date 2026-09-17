// SoundWave server — Punjabi multi-source backend (DJPunjab + DJJohal + Mr-Jatt/PenduJatt)
// with fastest-mirror audio + instant Tidal FLAC previews.
import express from 'express';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { mountAuth } from './auth.js';
import { desDecryptBase64 } from './des.js';
import { ytVideoSearch, ytVideoInfo } from './youtube.js';

const app = express();
const PORT = process.env.PORT || 5000;
// process safety nets: a stray rejection must never silently corrupt state,
// and an uncaught exception must crash LOUD (supervisor restarts clean)
process.on('unhandledRejection', (e) => console.error('[fatal] unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => { console.error('[fatal] uncaughtException:', e?.message || e); process.exit(1); });
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ---------------- CORS ----------------
// The shipped single-process deployment is same-origin (server serves ../client/dist),
// so a browser sends no Origin and this is a no-op. It only engages when the front
// end is hosted elsewhere — e.g. the static client on Vercel pointing VITE_API_URL at
// this server. Without it every /api fetch is blocked by the browser, and the WebAudio
// graph (EQ / visualizer) is muted because cross-origin media is tainted.
//
// FRONTEND_URL accepts a comma/space-separated allowlist, e.g.
//   FRONTEND_URL=https://soundwave.vercel.app,https://soundwave-nh48.onrender.com
// Unset = allow any origin (all public read-only endpoints), never credentials.
const CORS_ORIGINS = (process.env.FRONTEND_URL || '')
  .split(/[,\s]+/)
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function corsOrigin(req) {
  const o = req.headers.origin;
  if (!o) return null;                       // same-origin / curl: no CORS headers needed
  if (CORS_ORIGINS.length === 0) return '*'; // nothing configured: public data, any origin
  return CORS_ORIGINS.includes(o.replace(/\/+$/, '')) ? o : null;
}

app.use((req, res, next) => {
  const allow = corsOrigin(req);
  if (!allow) return next();                 // disallowed origin: serve with no CORS headers
  res.setHeader('Access-Control-Allow-Origin', allow);
  // res.vary() appends rather than overwriting, so this composes with the
  // 'Accept-Encoding' the compression middleware adds. Never let one origin's
  // response be served from cache to another.
  if (allow !== '*') res.vary('Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Access-Control-Expose-Headers', 'X-Audio-Cache, X-Audio-Bitrate, X-Audio-Mirror, X-Audio-Recovered, Content-Range, Content-Length');
  if (req.method === 'OPTIONS') return res.status(204).end(); // preflight: answer, don't route
  next();
});

app.use(compression({
  filter: (req, res) => {
    if (req.path === '/api/audio' || req.path === '/api/tidal-preview') return false; // byte streams: identity only
    return compression.filter(req, res);
  },
}));
app.use(express.json({ limit: '256kb' }));

// ---------------- scale guards: rate limits + API timeouts ----------------
// generous per-IP sliding windows (abuse shield, not a user cap)
const rateBuckets = new Map(); // key -> { t, n }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now - v.t > 120000) rateBuckets.delete(k);
}, 60000).unref();
app.use('/api', (req, res, next) => {
  const audio = req.path === '/audio';
  const key = `${req.ip || 'x'}:${audio ? 'a' : 'm'}`;
  const max = audio ? 600 : 240;
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now - b.t > 60000) {
    b = { t: now, n: 0 }; rateBuckets.set(key, b);
    if (rateBuckets.size > 2000) {
      for (const [k, v] of rateBuckets) { if (now - v.t > 60000) rateBuckets.delete(k); }
    }
  }
  if (++b.n > max) { res.setHeader('Retry-After', '30'); return res.status(429).json({ error: 'Too many requests, slow down' }); }
  next();
});
// hard timeout for metadata APIs (audio/preview streams legitimately run long)
const SLOW_API = new Set(['/audio', '/tidal-preview']);
app.use('/api', (req, res, next) => {
  if (SLOW_API.has(req.path)) return next();
  const to = setTimeout(() => { if (!res.headersSent) res.status(503).json({ error: 'Upstream slow, try again' }); }, 55000);
  res.on('finish', () => clearTimeout(to));
  next();
});
// slow-endpoint log (scaling observability)
app.use('/api', (req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    if (ms > 8000) console.log(`[slow] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ---------------- tiny TTL cache ----------------
const cache = new Map(); // key -> { v, t, ttl }
function getCache(key) {
  const h = cache.get(key);
  if (!h) return null;
  if (Date.now() - h.t > h.ttl) { cache.delete(key); return null; }
  return h.v;
}
function setCache(key, val, ttl = 5 * 60 * 1000) {
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(key, { v: val, t: Date.now(), ttl });
}

// ---------------- shared fetch ----------------
const DJP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
/** Provider call with a hard cap — stragglers resolve empty instead of stalling. */
function safeSearch(p, ms) { return Promise.race([p.catch(() => []), sleep(ms).then(() => [])]); }

// outbound concurrency guard: many users x deep fan-out must not pile up sockets
// or trip provider rate limits — metadata fetches queue here instead.
const OUT_GLOBAL = 48, OUT_PER_HOST = 8;
let outActive = 0;
const outQueue = [];
const outHostActive = new Map();
function outHost(url) { try { return new URL(url).host; } catch { return ''; } }
async function outAcquire(url) {
  const host = outHost(url);
  while (outActive >= OUT_GLOBAL || (outHostActive.get(host) || 0) >= OUT_PER_HOST) {
    await new Promise(r => outQueue.push(r));
  }
  outActive++;
  outHostActive.set(host, (outHostActive.get(host) || 0) + 1);
}
function outRelease(url) {
  const host = outHost(url);
  outActive = Math.max(0, outActive - 1);
  outHostActive.set(host, Math.max(0, (outHostActive.get(host) || 1) - 1));
  const w = outQueue.shift();
  if (w) w();
}

/** GET text with retries (reliability first). */
async function fetchText(url, { timeout = 20000, referer = null } = {}) {
  let lastErr = null;
  await outAcquire(url);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeout);
      try {
        const r = await fetch(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': DJP_UA, ...(referer ? { Referer: referer } : {}), Accept: 'text/html,*/*' },
        });
        if (r.status === 429) { await sleep(3000 + attempt * 2000); throw new Error('HTTP 429'); }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.text();
      } catch (e) { lastErr = e; await sleep(400 * (attempt + 1)); }
      finally { clearTimeout(to); }
    }
  } finally { outRelease(url); }
  throw lastErr;
}

const INDEX_TTL = 6 * 3600 * 1000;
const PAGE_TTL = 6 * 3600 * 1000;
const AUDIO_TTL = 60 * 60 * 1000;
const AUDIO_MAX = 12;
// byte cap beats count cap: 12 x 20MB would OOM a 512MB free tier under load
const AUDIO_CACHE_MB = Math.max(8, parseInt(process.env.AUDIO_CACHE_MB || '160', 10) || 160);
let audioCacheBytes = 0;

function djpScore(slug, words) {
  const s = ` ${fold(slug).replace(/-/g, ' ')} `;
  let score = 0;
  for (const w of words) {
    if (s.includes(` ${w} `)) score += 3;
    else if (s.includes(` ${w}`)) score += 2;
    else if (s.includes(w)) score += 1;
    else score -= 2;
  }
  return score;
}
function prettySlug(slug) {
  return String(slug || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function slugifyName(n) {
  return String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function queryWords(q) {
  return fold(q).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
}

const djpPageCache = new Map(); // url -> { data, time } (shared by all sources)
function pageCacheGet(url) {
  const hit = djpPageCache.get(url);
  if (hit && Date.now() - hit.time < PAGE_TTL) return hit.data;
  return null;
}
function pageCacheSet(url, data) {
  if (djpPageCache.size > 600) djpPageCache.delete(djpPageCache.keys().next().value);
  djpPageCache.set(url, { data, time: Date.now() });
}
function pageCacheDel(url) {
  try { djpPageCache.delete(url); } catch { /* noop */ }
}

/** Track duration via 1-byte Range probe (bytes ÷ bitrate). Non-fatal. */
async function headDuration(url, kbps) {
  if (!url || !kbps) return 0;
  try {
    await outAcquire(url);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    try {
      const h = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': DJP_UA, Range: 'bytes=0-0' } });
      const cr = h.headers.get('content-range') || '';
      const len = parseInt(cr.split('/')[1] || h.headers.get('content-length') || '0', 10);
      if (len > 100000) return Math.round((len * 8) / (kbps * 1000));
    } finally { clearTimeout(to); outRelease(url); }
  } catch { /* unknown */ }
  return 0;
}

// ---------------- DJPunjab ----------------
const DJP_BASE = (process.env.DJP_BASE_URL || 'https://djpunjab.is').replace(/\/$/, '');

function parseDjpLoc(url) {
  const sm = String(url).match(/\/(single-track|punjabi-music)\/(.+?)-(\d+)\.html$/);
  if (!sm) return null;
  return { id: sm[3], url, slug: sm[2].replace(/-mp3-song$|-album$/, ''), album: /-album-\d+\.html$/.test(url) };
}

let djpIndex = new Map(), djpIndexTime = 0, djpIndexPromise = null, djpLatestIds = [];
async function djpLoadIndex() {
  if (djpIndex.size && Date.now() - djpIndexTime < INDEX_TTL) return djpIndex;
  if (!djpIndexPromise) {
    djpIndexPromise = (async () => {
      const map = new Map();
      try {
        const xml = await fetchText(`${DJP_BASE}/sitemap.xml`, { timeout: 30000, referer: `${DJP_BASE}/` });
        for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
          const p = parseDjpLoc(m[1]);
          if (p) map.set(p.id, p);
        }
      } catch (e) { console.error('djp sitemap failed:', e.message); }
      const fresh = [];
      try {
        const html = await fetchText(`${DJP_BASE}/page/latest.html`, { timeout: 20000, referer: `${DJP_BASE}/` });
        for (const m of html.matchAll(/href="([^"]*?-(?:mp3-song|album)-\d+\.html)"/gi)) {
          const u = m[1].startsWith('http') ? m[1] : DJP_BASE + m[1];
          const p = parseDjpLoc(u.replace(/&amp;/g, '&'));
          if (p && !p.album) { map.set(p.id, p); fresh.push(p.id); }
        }
      } catch (e) { console.error('djp latest chart failed:', e.message); }
      djpLatestIds = fresh;
      if (map.size > 100) { djpIndex = map; djpIndexTime = Date.now(); }
      else console.error(`djp index too small (${map.size}) — keeping previous`);
      return djpIndex;
    })().finally(() => { djpIndexPromise = null; });
  }
  return djpIndexPromise;
}

async function djpSongPage(url) {
  const hit = pageCacheGet(url);
  if (hit) return hit;
  const html = await fetchText(url, { referer: `${DJP_BASE}/` });
  const mp3s = {};
  for (const m of html.matchAll(/https:\/\/s\d+\.djpunjab\.is\/data\/(48|128|320)\/\d+\/\d+\/[^"']+\.mp3/gi)) {
    mp3s[m[1]] = m[0].replace(/&amp;/g, '&');
  }
  const file = decodeURIComponent((mp3s['320'] || mp3s['128'] || mp3s['48'] || '').split('/').pop() || '');
  let title = '', artist = '';
  const fm = file.replace(/\.mp3$/i, '').split(' - ');
  if (fm.length >= 2) { artist = fm.pop().trim(); title = fm.join(' - ').trim(); }
  if (!title) {
    const t = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
    title = t.replace(/\s*mp3 songs? download djpunjab\s*/gi, '').trim() || 'Unknown';
  }
  const cover = html.match(/https:\/\/cover\.djpunjab\.is\/[^"']+\.(?:webp|jpg)/i)?.[0] || '';
  const br = mp3s['320'] ? 320 : mp3s['128'] ? 128 : 48;
  const duration = await headDuration(mp3s['320'] || mp3s['128'] || mp3s['48'] || '', br);
  const data = { mp3: mp3s['320'] || mp3s['128'] || mp3s['48'] || '', mp3s, quality: mp3s['320'] ? '320' : mp3s['128'] ? '128' : '48', title, artist: artist || 'Unknown', cover, duration };
  pageCacheSet(url, data);
  return data;
}

async function djpAlbumPage(url) {
  const hit = pageCacheGet(url);
  if (hit) return hit;
  const html = await fetchText(url, { referer: `${DJP_BASE}/` });
  const cover = html.match(/https:\/\/cover\.djpunjab\.is\/[^"']+\.(?:webp|jpg)/i)?.[0] || '';
  const title = (html.match(/<title>([^<]*)<\/title>/i)?.[1] || '').replace(/\s*mp3 songs? download djpunjab\s*/gi, '').trim();
  const trackUrls = [...new Set([...html.matchAll(/href="((?:https:\/\/djpunjab\.is)?\/(?:single-track|punjabi-music)\/[^"]*?mp3-song-\d+\.html)"/gi)].map(m => (m[1].startsWith('http') ? m[1] : DJP_BASE + m[1]).replace(/&amp;/g, '&')))];
  const data = { cover, title, trackUrls, isAlbum: true };
  pageCacheSet(url, data);
  return data;
}

function normalizeDjpSong(id, pg) {
  if (!id || !pg?.mp3) return null;
  return {
    id: `djp:${id}`, source: 'djp', sourceId: String(id), type: 'track',
    title: pg.title || 'Unknown',
    artist: { id: '', name: pg.artist || 'Unknown', image: pg.cover || '' },
    artists: [], album: { id: '', name: '', image: pg.cover || '' },
    duration: pg.duration || 0, image: pg.cover || '',
    streamUrl: `/api/audio?src=djp&id=${encodeURIComponent(id)}`, previewUrl: '', isPreview: false,
    codec: 'mp3', quality: pg.quality, explicit: false, year: '', language: '', plays: 0,
  };
}

async function djpSearchSongs(q, limit = 15) {
  const idx = await djpLoadIndex().catch(() => new Map());
  if (!idx.size) return [];
  const words = queryWords(q);
  if (!words.length) return [];
  const songHits = [], albumHits = [];
  for (const [id, e] of idx) {
    const s = djpScore(e.slug, words);
    if (s <= 0) continue;
    (e.album ? albumHits : songHits).push([s, id, e]);
  }
  songHits.sort((a, b) => b[0] - a[0]);
  albumHits.sort((a, b) => b[0] - a[0]);
  const pages = await Promise.all(songHits.slice(0, limit).map(([, id, e]) => djpSongPage(e.url).then(pg => ({ id, pg })).catch(() => null)));
  const out = pages.filter(Boolean).map(({ id, pg }) => normalizeDjpSong(id, pg)).filter(Boolean);
  if (out.length < limit && albumHits.length) {
    const need = limit - out.length;
    const albPages = await Promise.all(albumHits.slice(0, Math.min(need, 6)).map(([, , e]) => djpAlbumPage(e.url).catch(() => null)));
    const jobs = [];
    for (const pg of albPages) {
      if (!pg) continue;
      for (const u of (pg.trackUrls || []).slice(0, 2)) {
        const tid = (u.match(/mp3-song-(\d+)\.html/) || [])[1];
        if (tid) jobs.push([tid, u]);
      }
      if (jobs.length >= need * 2) break;
    }
    const more = await Promise.all(jobs.slice(0, need * 2).map(async ([tid, u]) => {
      try { return normalizeDjpSong(tid, await djpSongPage(u)); } catch { return null; }
    }));
    const seen = new Set(out.map(t => t.id));
    for (const t of more.filter(Boolean)) {
      if (!seen.has(t.id) && out.length < limit) { seen.add(t.id); out.push(t); }
    }
  }
  return out;
}

async function djpSearchAlbums(q, limit = 8) {
  const idx = await djpLoadIndex().catch(() => new Map());
  if (!idx.size) return [];
  const words = queryWords(q);
  if (!words.length) return [];
  const scored = [];
  for (const [id, e] of idx) {
    if (!e.album) continue;
    const s = djpScore(e.slug, words);
    if (s > 0) scored.push([s, id, e]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const pages = await Promise.all(scored.slice(0, limit).map(([, id, e]) => djpAlbumPage(e.url).then(pg => ({ id, e, pg })).catch(() => null)));
  return pages.filter(Boolean).map(({ id, e, pg }) => ({
    id: `djp:al:${id}`, source: 'djp', sourceId: String(id), type: 'album',
    name: pg.title || prettySlug(e.slug), artist: '', image: pg.cover || '', year: '',
    trackCount: (pg.trackUrls || []).length,
  }));
}

async function djpSearchArtists(q, limit = 8) {
  const songs = await djpSearchSongs(q, 12).catch(() => []);
  const seen = new Map();
  for (const t of songs) {
    const n = t.artist?.name || '';
    if (!n || n === 'Unknown') continue;
    const slug = slugifyName(n);
    if (!slug || seen.has(slug)) continue;
    seen.set(slug, { id: `djp:ar:${slug}`, source: 'djp', type: 'artist', name: n, image: t.image || '' });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

async function djpArtistDetail(slug) {
  slug = slugifyName(slug);
  const words = slug.split('-').filter(w => w.length > 1);
  const ids = [];
  try {
    const html = await fetchText(`${DJP_BASE}/artist/${slug}-top-songs`, { timeout: 15000, referer: `${DJP_BASE}/` });
    for (const m of html.matchAll(/href="([^"]*?mp3-song-(\d+)\.html)"/gi)) {
      const u = (m[1].startsWith('http') ? m[1] : DJP_BASE + m[1]).replace(/&amp;/g, '&');
      ids.push([m[2], u]);
    }
  } catch { /* use index fallback below */ }
  const idx = await djpLoadIndex().catch(() => new Map());
  if (ids.length < 5 && words.length && idx.size) {
    for (const [id, e] of idx) {
      if (e.album) continue;
      if (words.every(w => e.slug.includes(w))) ids.push([id, e.url]);
      if (ids.length >= 30) break;
    }
  }
  if (ids.length < 8 && words.length && idx.size) {
    const albHits = [];
    for (const [id, e] of idx) {
      if (!e.album) continue;
      if (words.every(w => e.slug.includes(w))) albHits.push(e.url);
      if (albHits.length >= 6) break;
    }
    const albPages = await Promise.all(albHits.map(u => djpAlbumPage(u).catch(() => null)));
    for (const pg of albPages) {
      if (!pg) continue;
      for (const u of (pg.trackUrls || []).slice(0, 2)) {
        const tid = (u.match(/mp3-song-(\d+)\.html/) || [])[1];
        if (tid) ids.push([tid, u]);
      }
      if (ids.length >= 30) break;
    }
  }
  const seen = new Set();
  const uniq = ids.filter(([id]) => !seen.has(String(id)) && seen.add(String(id))).slice(0, 20);
  const songs = (await Promise.all(uniq.map(async ([id, u]) => {
    try { return normalizeDjpSong(id, await djpSongPage(u)); } catch { return null; }
  }))).filter(Boolean);
  if (!songs.length) return null;
  const name = songs[0].artist?.name && songs[0].artist.name !== 'Unknown' ? songs[0].artist.name : prettySlug(slug);
  let topAlbums = [];
  if (words.length && idx.size) {
    const scored = [];
    for (const [id, e] of idx) {
      if (!e.album) continue;
      const s = djpScore(e.slug, words);
      if (s > 0) scored.push([s, id, e]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const pages = await Promise.all(scored.slice(0, 4).map(([, id, e]) => djpAlbumPage(e.url).then(pg => ({ id, e, pg })).catch(() => null)));
    topAlbums = pages.filter(Boolean).map(({ id, e, pg }) => ({
      id: `djp:al:${id}`, source: 'djp', type: 'album', name: pg.title || prettySlug(e.slug),
      artist: name, image: pg.cover || '', year: '', trackCount: (pg.trackUrls || []).length,
    }));
  }
  return {
    id: `djp:ar:${slug}`, source: 'djp', type: 'artist', name,
    image: songs[0].image || '', topSongs: songs, topAlbums, tags: [],
  };
}

// ---------------- DJJohal ----------------
const DJ_BASE = 'https://www.djjohal.com';
let djIndex = new Map(), djIndexTime = 0, djIndexPromise = null;
const djCustom = new Map(); // t:{numId} -> page data (album-only tracks)

async function djLoadIndex() {
  if (djIndex.size && Date.now() - djIndexTime < INDEX_TTL) return djIndex;
  if (!djIndexPromise) {
    djIndexPromise = (async () => {
      const map = new Map();
      try {
        const xml = await fetchText(`${DJ_BASE}/sitemaps/sitemap-001.xml`, { timeout: 90000, referer: `${DJ_BASE}/` });
        for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
          const u = m[1];
          let sm = u.match(/\/single\/([a-z0-9-]+)\.html$/i);
          if (sm) { const slug = sm[1].toLowerCase(); map.set(slug, { id: slug, url: u, slug, album: false }); continue; }
          sm = u.match(/\/album\/([a-z0-9-]+)\.html$/i);
          if (sm) { const slug = sm[1].toLowerCase(); map.set('al:' + slug, { id: slug, url: u, slug, album: true }); }
        }
      } catch (e) { console.error('dj sitemap failed:', e.message); }
      if (map.size > 1000) { djIndex = map; djIndexTime = Date.now(); }
      else console.error(`dj index too small (${map.size}) — keeping previous`);
      return djIndex;
    })().finally(() => { djIndexPromise = null; });
  }
  return djIndexPromise;
}

async function djSongPage(url) {
  const hit = pageCacheGet(url);
  if (hit) return hit;
  const html = await fetchText(url, { referer: `${DJ_BASE}/` });
  const mp3s = {};
  let numId = '';
  for (const m of html.matchAll(/https:\/\/(?:hd1|sd2|lq)\.djjohal\.com\/(320|128|48)\/(\d+)\/[^"']+\.mp3/gi)) {
    if (!mp3s[m[1]]) mp3s[m[1]] = m[0].replace(/&amp;/g, '&');
    if (!numId) numId = m[2];
  }
  const file = decodeURIComponent((mp3s['320'] || mp3s['128'] || mp3s['48'] || '').split('/').pop() || '');
  let title = '', artist = '';
  const base = file.replace(/\s*\([^)]*\)\.mp3$/i, '').replace(/\.mp3$/i, '');
  const parts = base.split(' - ');
  if (parts.length >= 2) { artist = parts.pop().trim(); title = parts.join(' - ').trim(); }
  if (!title || !artist || artist === 'Unknown') {
    const t = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
    const tb = t.split(' by ');
    if (!title) title = (tb[0] || '').split('|')[0].trim() || title;
    if (!artist || artist === 'Unknown') artist = ((tb[1] || '').split('|')[0].split('-')[0] || '').trim() || artist;
  }
  const cover = html.match(/https:\/\/lq\.djjohal\.com\/covers_webp\/[^"']+\.webp/i)?.[0] || '';
  const br = mp3s['320'] ? 320 : mp3s['128'] ? 128 : 48;
  const duration = await headDuration(mp3s['320'] || mp3s['128'] || mp3s['48'] || '', br);
  const data = { mp3s, numId, title: title || 'Unknown', artist: artist || 'Unknown', cover, duration };
  pageCacheSet(url, data);
  return data;
}

function djBareMp3s(numId) {
  return {
    320: `https://hd1.djjohal.com/320/${numId}/track.mp3`,
    128: `https://sd2.djjohal.com/128/${numId}/track.mp3`,
    48: `https://lq.djjohal.com/48/${numId}/track.mp3`,
  };
}

async function djAlbumPage(url, withDur = true) {
  const key = `dj-album:${url}`;
  const hit = pageCacheGet(key);
  if (hit && (!withDur || hit.durDone)) return hit;
  const html = await fetchText(url, { referer: `${DJ_BASE}/` });
  const rawTitle = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
  let title = rawTitle.split('|')[0].trim(), artist = '';
  const bym = rawTitle.match(/^(.*?)\s+by\s+(.*?)\s*-\s*(?:EP|Album|Single)/i);
  if (bym) { title = bym[1].trim(); artist = bym[2].trim(); }
  const cover = html.match(/https:\/\/lq\.djjohal\.com\/covers_webp\/[^"']+\.webp/i)?.[0] || '';
  const artistWords = new Set(artist.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1));
  const tracks = [];
  const seen = new Set();
  for (const chunk of html.split('<button')) {
    const m = chunk.match(/data-audio="[^"]*?\/(\d+)\.mp3"/i);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    // exact title: data-url song slug minus trailing artist words
    let t = '';
    let slug = (chunk.match(/data-url="[^"]*?\/song\/([a-z0-9-]+)\.html"/i) || [])[1] || '';
    if (!slug) {
      const back = html.slice(Math.max(0, html.indexOf(chunk) - 600), html.indexOf(chunk) + chunk.length);
      slug = (back.match(/data-url="[^"]*?\/song\/([a-z0-9-]+)\.html"/i) || [])[1] || '';
    }
    if (slug) {
      const parts = slug.toLowerCase().split('-');
      while (parts.length > 1 && artistWords.has(parts[parts.length - 1])) parts.pop();
      t = prettySlug(parts.join('-'));
    }
    if (!t) {
      let text = chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(-100).replace(/^[>\s]+/, '').trim();
      if (artist && text.toLowerCase().endsWith(artist.toLowerCase())) text = text.slice(0, -artist.length).trim();
      t = text.replace(/\s*[·•\-–]\s*$/, '').trim();
    }
    tracks.push({ numId: m[1], title: t || `Track ${tracks.length + 1}`, artist });
  }
  let durations = tracks.map(() => 0);
  if (withDur && tracks.length) {
    durations = await Promise.all(tracks.map(tr => headDuration(`https://sd2.djjohal.com/128/${tr.numId}/track.mp3`, 128)));
  }
  const data = { cover, title: title || 'Unknown Album', artist, isAlbum: true, durDone: withDur, tracks: tracks.map((tr, i) => ({ ...tr, mp3s: djBareMp3s(tr.numId), duration: durations[i] || 0 })) };
  pageCacheSet(key, data);
  return data;
}

function normalizeDjSong(slug, pg) {
  if (!slug || !pg || !Object.keys(pg.mp3s || {}).length) return null;
  const quality = pg.mp3s['320'] ? '320' : pg.mp3s['128'] ? '128' : '48';
  return {
    id: `dj:${slug}`, source: 'dj', sourceId: String(slug), type: 'track',
    title: pg.title || 'Unknown',
    artist: { id: '', name: pg.artist || 'Unknown', image: pg.cover || '' },
    artists: [], album: { id: '', name: '', image: pg.cover || '' },
    duration: pg.duration || 0, image: pg.cover || '',
    streamUrl: `/api/audio?src=dj&id=${encodeURIComponent(slug)}`, previewUrl: '', isPreview: false,
    codec: 'mp3', quality, explicit: false, year: '', language: '', plays: 0,
  };
}

function normalizeDjTrack(tr, cover) {
  const pg = { mp3s: tr.mp3s, title: tr.title, artist: tr.artist || 'Unknown', cover: cover || '', duration: tr.duration || 0 };
  djCustom.set(`t:${tr.numId}`, pg);
  if (djCustom.size > 500) djCustom.delete(djCustom.keys().next().value);
  return {
    id: `dj:t:${tr.numId}`, source: 'dj', sourceId: `t:${tr.numId}`, type: 'track',
    title: tr.title, artist: { id: '', name: tr.artist || 'Unknown', image: cover || '' },
    artists: [], album: { id: '', name: '', image: cover || '' },
    duration: tr.duration || 0, image: cover || '',
    streamUrl: `/api/audio?src=dj&id=t:${tr.numId}`, previewUrl: '', isPreview: false,
    codec: 'mp3', quality: '320', explicit: false, year: '', language: '', plays: 0,
  };
}

async function djSearchSongs(q, limit = 8) {
  const idx = await djLoadIndex().catch(() => new Map());
  if (!idx.size) return [];
  const words = queryWords(q);
  if (!words.length) return [];
  const songHits = [], albumHits = [];
  for (const [key, e] of idx) {
    const s = djpScore(e.slug, words);
    if (s <= 0) continue;
    (e.album ? albumHits : songHits).push([s, key, e]);
  }
  songHits.sort((a, b) => b[0] - a[0]);
  albumHits.sort((a, b) => b[0] - a[0]);
  const pages = await Promise.all(songHits.slice(0, limit).map(([, key, e]) => djSongPage(e.url).then(pg => ({ key, pg })).catch(() => null)));
  const out = pages.filter(Boolean).map(({ key, pg }) => normalizeDjSong(key, pg)).filter(Boolean);
  if (out.length < limit && albumHits.length) {
    const need = limit - out.length;
    const albPages = await Promise.all(albumHits.slice(0, Math.min(need, 4)).map(([, , e]) => djAlbumPage(e.url, false).catch(() => null)));
    for (const pg of albPages) {
      if (!pg) continue;
      for (const tr of (pg.tracks || []).slice(0, 2)) {
        if (out.length >= limit) break;
        out.push(normalizeDjTrack({ ...tr, artist: tr.artist || pg.artist }, pg.cover));
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function djSearchAlbums(q, limit = 4) {
  const idx = await djLoadIndex().catch(() => new Map());
  if (!idx.size) return [];
  const words = queryWords(q);
  if (!words.length) return [];
  const scored = [];
  for (const [key, e] of idx) {
    if (!e.album) continue;
    const s = djpScore(e.slug, words);
    if (s > 0) scored.push([s, key, e]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const pages = await Promise.all(scored.slice(0, limit).map(([, key, e]) => djAlbumPage(e.url, false).then(pg => ({ key, pg })).catch(() => null)));
  return pages.filter(Boolean).map(({ key, pg }) => ({
    id: `dj:al:${key.replace(/^al:/, '')}`, source: 'dj', sourceId: key, type: 'album',
    name: pg.title || 'Unknown', artist: pg.artist || '', image: pg.cover || '', year: '',
    trackCount: (pg.tracks || []).length,
  }));
}

async function djSearchArtists(q, limit = 6) {
  const songs = await djSearchSongs(q, 10).catch(() => []);
  const seen = new Map();
  for (const t of songs) {
    const n = t.artist?.name || '';
    if (!n || n === 'Unknown') continue;
    const slug = slugifyName(n);
    if (!slug || seen.has(slug)) continue;
    seen.set(slug, { id: `dj:ar:${slug}`, source: 'dj', type: 'artist', name: n, image: t.image || '' });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

async function djArtistDetail(slug) {
  slug = slugifyName(slug);
  const words = slug.split('-').filter(w => w.length > 1);
  let slugs = [];
  try {
    const html = await fetchText(`${DJ_BASE}/artist/${slug}.html`, { timeout: 15000, referer: `${DJ_BASE}/` });
    const found = [...new Set([...html.matchAll(/\/single\/([a-z0-9-]+)\.html/gi)].map(m => m[1].toLowerCase()))];
    slugs = found.slice(0, 20);
  } catch { /* fallback below */ }
  const idx = await djLoadIndex().catch(() => new Map());
  if (slugs.length < 5 && words.length && idx.size) {
    for (const [key, e] of idx) {
      if (e.album) continue;
      if (words.every(w => e.slug.includes(w))) slugs.push(key);
      if (slugs.length >= 25) break;
    }
  }
  slugs = [...new Set(slugs)].slice(0, 20);
  const songs = (await Promise.all(slugs.map(async s => {
    try {
      const e = idx.get(s);
      if (!e) return null;
      return normalizeDjSong(s, await djSongPage(e.url));
    } catch { return null; }
  }))).filter(Boolean);
  if (!songs.length) return null;
  const name = songs[0].artist?.name && songs[0].artist.name !== 'Unknown' ? songs[0].artist.name : prettySlug(slug);
  return { id: `dj:ar:${slug}`, source: 'dj', type: 'artist', name, image: songs[0].image || '', topSongs: songs, topAlbums: [], tags: [] };
}

// ---------------- Mr-Jatt (+ PenduJatt mirror: same DB, same CDN) ----------------
const MRJ_BASE = 'https://www.mr-jatt.im';
const PDJ_BASE = 'https://pendujatt.pro';
function mrjFallbackUrl(url) {
  return String(url).replace(`${MRJ_BASE}/punjabi-music/`, `${PDJ_BASE}/categorylist/`).replace(MRJ_BASE, PDJ_BASE);
}
let mrjIndex = new Map(), mrjIndexTime = 0, mrjIndexPromise = null;

async function mrjLoadIndex() {
  if (mrjIndex.size && Date.now() - mrjIndexTime < INDEX_TTL) return mrjIndex;
  if (!mrjIndexPromise) {
    mrjIndexPromise = (async () => {
      const map = new Map();
      const [songsXml, albumsXml] = await Promise.all([
        fetchText(`${MRJ_BASE}/songs-sitemap1.xml`, { timeout: 60000, referer: `${MRJ_BASE}/` }).catch(e => { console.error('mrj songs sitemap failed:', e.message); return ''; }),
        fetchText(`${MRJ_BASE}/albums-sitemap1.xml`, { timeout: 60000, referer: `${MRJ_BASE}/` }).catch(e => { console.error('mrj albums sitemap failed:', e.message); return ''; }),
      ]);
      for (const m of songsXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const sm = m[1].match(/\/punjabi-music\/song\/(\d+)\/([^\/]+?)-mp3-song\.html$/i);
        if (sm) map.set(sm[1], { id: sm[1], url: m[1], slug: sm[2], album: false });
      }
      for (const m of albumsXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const sm = m[1].match(/\/punjabi-music\/album\/(\d+)\/([^\/]+?)-mp3-songs\.html$/i);
        if (sm) map.set('al:' + sm[1], { id: sm[1], url: m[1], slug: sm[2], album: true });
      }
      if (map.size > 1000) { mrjIndex = map; mrjIndexTime = Date.now(); }
      else console.error(`mrj index too small (${map.size}) — keeping previous`);
      return mrjIndex;
    })().finally(() => { mrjIndexPromise = null; });
  }
  return mrjIndexPromise;
}

async function mrjFetchHtml(url) {
  try {
    return await fetchText(url, { referer: `${MRJ_BASE}/` });
  } catch (e) {
    const fb = mrjFallbackUrl(url); // PenduJatt serves the same song IDs
    if (fb === url) throw e;
    return await fetchText(fb, { referer: `${PDJ_BASE}/` });
  }
}

function mrjParseSongHtml(html, url) {
  const mp3s = {};
  for (const m of html.matchAll(/https:\/\/cdnsongs\.com\/[^"']*?\/(48|128|320)\/[^"']+\.mp3/gi)) {
    const u = m[0].replace(/&amp;/g, '&');
    (mp3s[m[1]] = mp3s[m[1]] || []).push(u);
  }
  for (const br of Object.keys(mp3s)) {
    mp3s[br] = [...new Set(mp3s[br])].sort((a, b) => (a.includes('/dren/') ? 1 : 0) - (b.includes('/dren/') ? 1 : 0));
  }
  const aSlugs = [...new Set([...html.matchAll(/\/artist\/([^"\/]+?)\.html/gi)].map(x => x[1]))].slice(0, 3);
  const aSlug = aSlugs[0] || '';
  const artist = aSlugs.map(s => s.replace(/-/g, ' ')).join(', ') || 'Unknown';
  const slug = (url.match(/\/song\/\d+\/([^\/]+?)-mp3-song\.html/i)?.[1] || '').replace(/\.html$/i, '');
  let title = prettySlug(slug) || 'Unknown';
  const aWords = new Set(aSlugs.join('-').toLowerCase().split('-').filter(w => w.length > 1));
  if (aWords.size && slug) {
    const parts = slug.split('-');
    while (parts.length > 1 && aWords.has(parts[parts.length - 1].toLowerCase())) parts.pop();
    title = prettySlug(parts.join('-')) || title;
  }
  const cover = html.match(/https:\/\/cover\.mr-jatt\.im\/[^"']+\.(?:jpg|jpeg|webp)/i)?.[0] || html.match(/https:\/\/image\.pendujatt\.pro\/[^"']+\.(?:webp|jpg)/i)?.[0] || '';
  return { mp3s, artistSlug: aSlug, title, artist, cover };
}

async function mrjSongPage(url) {
  const hit = pageCacheGet(url);
  if (hit && !hit.isAlbum) return hit;
  const html = await mrjFetchHtml(url);
  const data = mrjParseSongHtml(html, url);
  const br = data.mp3s['320'] ? 320 : data.mp3s['128'] ? 128 : 48;
  const first = (v) => Array.isArray(v) ? v[0] : v;
  data.duration = await headDuration(first(data.mp3s['320']) || first(data.mp3s['128']) || first(data.mp3s['48']) || '', br);
  data.quality = data.mp3s['320'] ? '320' : data.mp3s['128'] ? '128' : '48';
  pageCacheSet(url, data);
  return data;
}

async function mrjAlbumPage(url) {
  const key = `mrj-album:${url}`;
  const hit = pageCacheGet(key);
  if (hit) return hit;
  const doFetch = async (u) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(u, { signal: ctrl.signal, headers: { 'User-Agent': DJP_UA, Referer: `${MRJ_BASE}/` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { finalUrl: r.url, html: await r.text() };
    } finally { clearTimeout(to); }
  };
  let finalUrl, html;
  try {
    ({ finalUrl, html } = await doFetch(url));
  } catch (e) {
    const fb = mrjFallbackUrl(url);
    if (fb === url) throw e;
    ({ finalUrl, html } = await doFetch(fb));
  }
  if (finalUrl.includes('/song/')) {
    // single-track "album" redirects to the song page
    const data = { ...mrjParseSongHtml(html, finalUrl), single: true, isAlbum: true, trackIds: [] };
    const br = data.mp3s['320'] ? 320 : data.mp3s['128'] ? 128 : 48;
    data.duration = await headDuration(data.mp3s['320'] || data.mp3s['128'] || data.mp3s['48'] || '', br);
    const sid = (finalUrl.match(/\/song\/(\d+)\//i) || [])[1] || '';
    data.singleId = sid;
    pageCacheSet(key, data);
    return data;
  }
  const title = ((html.match(/<title>([^<]*)<\/title>/i)?.[1] || '').split(/album mp3 songs Download/i)[0] || '').trim();
  const cover = html.match(/https:\/\/cover\.mr-jatt\.im\/[^"']+\.(?:jpg|jpeg|webp)/i)?.[0] || html.match(/https:\/\/image\.pendujatt\.pro\/[^"']+\.(?:webp|jpg)/i)?.[0] || '';
  const trackIds = [...new Set([...html.matchAll(/\/(?:punjabi-music|categorylist)\/song\/(\d+)\/[^"]*?mp3-song\.html/gi)].map(m => m[1]))];
  const data = { cover, title: title || 'Unknown Album', trackIds, isAlbum: true };
  pageCacheSet(key, data);
  return data;
}

function normalizeMrjSong(id, pg) {
  if (!id || !pg || !Object.keys(pg.mp3s || {}).length) return null;
  return {
    id: `mrj:${id}`, source: 'mrj', sourceId: String(id), type: 'track',
    title: pg.title || 'Unknown',
    artist: { id: pg.artistSlug ? `mrj:ar:${pg.artistSlug}` : '', name: pg.artist || 'Unknown', image: pg.cover || '' },
    artists: [], album: { id: '', name: '', image: pg.cover || '' },
    duration: pg.duration || 0, image: pg.cover || '',
    streamUrl: `/api/audio?src=mrj&id=${id}`, previewUrl: '', isPreview: false,
    codec: 'mp3', quality: pg.quality || '320', explicit: false, year: '', language: '', plays: 0,
  };
}

async function mrjSearchSongs(q, limit = 8) {
  const idx = await mrjLoadIndex().catch(() => new Map());
  if (!idx.size) return [];
  const words = queryWords(q);
  if (!words.length) return [];
  const songHits = [], albumHits = [];
  for (const [key, e] of idx) {
    const s = djpScore(e.slug, words);
    if (s <= 0) continue;
    (e.album ? albumHits : songHits).push([s, key, e]);
  }
  songHits.sort((a, b) => b[0] - a[0]);
  albumHits.sort((a, b) => b[0] - a[0]);
  const pages = await Promise.all(songHits.slice(0, limit).map(([, key, e]) => mrjSongPage(e.url).then(pg => ({ key, pg })).catch(() => null)));
  const out = pages.filter(Boolean).map(({ key, pg }) => normalizeMrjSong(key, pg)).filter(Boolean);
  if (out.length < limit && albumHits.length) {
    const need = limit - out.length;
    const albPages = await Promise.all(albumHits.slice(0, Math.min(need, 4)).map(([, , e]) => mrjAlbumPage(e.url).catch(() => null)));
    const jobs = [];
    for (const pg of albPages) {
      if (!pg) continue;
      if (pg.single && pg.singleId) jobs.push(pg.singleId);
      for (const tid of (pg.trackIds || []).slice(0, 2)) jobs.push(tid);
      if (jobs.length >= need * 2) break;
    }
    const more = await Promise.all([...new Set(jobs)].slice(0, need * 2).map(async (tid) => {
      try {
        const e = idx.get(String(tid));
        if (!e) return null;
        return normalizeMrjSong(tid, await mrjSongPage(e.url));
      } catch { return null; }
    }));
    const seen = new Set(out.map(t => t.id));
    for (const t of more.filter(Boolean)) {
      if (!seen.has(t.id) && out.length < limit) { seen.add(t.id); out.push(t); }
    }
  }
  return out;
}

async function mrjSearchAlbums(q, limit = 4) {
  const idx = await mrjLoadIndex().catch(() => new Map());
  if (!idx.size) return [];
  const words = queryWords(q);
  if (!words.length) return [];
  const scored = [];
  for (const [key, e] of idx) {
    if (!e.album) continue;
    const s = djpScore(e.slug, words);
    if (s > 0) scored.push([s, key, e]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const pages = await Promise.all(scored.slice(0, limit).map(([, key, e]) => mrjAlbumPage(e.url).then(pg => ({ key, e, pg })).catch(() => null)));
  return pages.filter(Boolean).map(({ key, e, pg }) => ({
    id: `mrj:al:${key.replace(/^al:/, '')}`, source: 'mrj', sourceId: key, type: 'album',
    name: pg.single ? (pg.title || prettySlug(e.slug)) : (pg.title || prettySlug(e.slug)),
    artist: pg.single ? (pg.artist || '') : '', image: pg.cover || '', year: '',
    trackCount: pg.single ? 1 : (pg.trackIds || []).length,
  }));
}

async function mrjSearchArtists(q, limit = 6) {
  const songs = await mrjSearchSongs(q, 10).catch(() => []);
  const seen = new Map();
  for (const t of songs) {
    const n = t.artist?.name || '';
    const aid = t.artist?.id || '';
    if (!n || n === 'Unknown') continue;
    const slug = aid.startsWith('mrj:ar:') ? aid.slice(7) : slugifyName(n);
    if (!slug || seen.has(slug.toLowerCase())) continue;
    seen.set(slug.toLowerCase(), { id: `mrj:ar:${slug}`, source: 'mrj', type: 'artist', name: n, image: t.image || '' });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

async function mrjArtistDetail(slug) {
  const words = String(slug || '').toLowerCase().split('-').filter(w => w.length > 1);
  let ids = [];
  try {
    const artistHtml = await mrjFetchHtml(`${MRJ_BASE}/artist/${slug}.html`);
    const topHref = artistHtml.match(/href="([^"]*?-top-songs\.html)"/i)?.[1] || `/${slug}-top-songs.html`;
    const topUrl = topHref.startsWith('http') ? topHref : MRJ_BASE + topHref;
    const topHtml = await mrjFetchHtml(topUrl);
    ids = [...new Set([...topHtml.matchAll(/\/(?:punjabi-music|categorylist)\/song\/(\d+)\/[^"]*?mp3-song\.html/gi)].map(m => m[1]))].slice(0, 20);
  } catch { /* fallback below */ }
  const idx = await mrjLoadIndex().catch(() => new Map());
  if (ids.length < 5 && words.length && idx.size) {
    for (const [key, e] of idx) {
      if (e.album) continue;
      if (words.every(w => e.slug.toLowerCase().includes(w))) ids.push(key);
      if (ids.length >= 25) break;
    }
  }
  ids = [...new Set(ids.map(String))].slice(0, 20);
  const songs = (await Promise.all(ids.map(async (sid) => {
    try {
      const e = idx.get(sid);
      if (!e) return null;
      return normalizeMrjSong(sid, await mrjSongPage(e.url));
    } catch { return null; }
  }))).filter(Boolean);
  if (!songs.length) return null;
  const name = songs[0].artist?.name && songs[0].artist.name !== 'Unknown' ? songs[0].artist.name : prettySlug(slug);
  return { id: `mrj:ar:${slug}`, source: 'mrj', type: 'artist', name, image: songs[0].image || '', topSongs: songs, topAlbums: [], tags: [] };
}


// ---------------- JioSaavn via Rhythmax API (search + decryptable streams) ----------------
const RTHMX = 'https://rthmx.vercel.app';
async function rthmx(path) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(`${RTHMX}${path}`, { signal: ctrl.signal, headers: { 'User-Agent': DJP_UA } });
    if (!r.ok) throw new Error(`rthmx HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}
let saavnDesWarned = false;
function saavnDecrypt(enc) {
  try {
    // Pure-JS DES (see des.js). Node dropped des-ecb from its default OpenSSL
    // provider in v17, which is why this used to need --openssl-legacy-provider.
    // Doing it in JS means no flag, so the server starts anywhere Node runs —
    // including embedded runtimes that reject that flag.
    return desDecryptBase64(enc, Buffer.from('38346591', 'utf8')).toString('utf8');
  } catch (e) {
    if (!saavnDesWarned) { saavnDesWarned = true; console.error('saavn DES failed:', e.message); }
    return '';
  }
}
function saavnTierUrls(decrypted) {
  const base = String(decrypted || '').trim();
  if (!/^https?:\/\//.test(base)) return {};
  const mk = (q) => base.replace(/_(96|160|320)(\.[a-z0-9]+)(\?.*)?$/i, `_${q}$2$3`);
  return { 320: mk('320'), 160: mk('160'), 96: mk('96') };
}
const saavnUrlCache = new Map(); // token -> { urls, time }
async function saavnStreamUrls(token) {
  const hit = saavnUrlCache.get(token);
  if (hit && Date.now() - hit.time < PAGE_TTL) return hit.urls;
  const j = await rthmx(`/api/song?token=${encodeURIComponent(token)}`);
  const enc = j?.more_info?.encrypted_media_url || j?.encrypted_media_url || '';
  const urls = saavnTierUrls(saavnDecrypt(enc));
  if (!Object.keys(urls).length) throw new Error('No stream URL');
  if (saavnUrlCache.size > 300) saavnUrlCache.delete(saavnUrlCache.keys().next().value);
  saavnUrlCache.set(token, { urls, time: Date.now() });
  return urls;
}
function saavnImage(u, size = 500) { return String(u || '').replace(/150x150|50x50/, `${size}x${size}`); }
function saavnArtistName(item) {
  const fromMi = item?.more_info?.artists?.primary;
  const ia = item?.artists;
  const fromItem = Array.isArray(ia) ? ia : ia?.primary;
  const prim = (fromMi?.length ? fromMi : fromItem) || [];
  if (prim.length) return prim.map(a => a.name).filter(Boolean).join(', ');
  return String(item?.subtitle || '').split(' - ')[0].trim() || 'Unknown';
}
function normalizeSaavnSong(item) {
  const token = item?.token;
  if (!token || !item?.title) return null;
  const name = saavnArtistName(item);
  const img = saavnImage(item.image);
  return {
    id: `saavn:${token}`, source: 'saavn', sourceId: String(token), type: 'track',
    title: item.title, artist: { id: `saavn:ar:${slugifyName(name)}`, name, image: img },
    artists: [], album: { id: '', name: '', image: img },
    duration: parseInt(item.duration || item.more_info?.duration || '0', 10) || 0, image: img,
    streamUrl: `/api/audio?src=saavn&id=${encodeURIComponent(token)}`, previewUrl: '', isPreview: false,
    codec: 'aac', quality: '320', explicit: !!item.isExplicit, year: item.year || '', language: (item.language || '').toLowerCase(), plays: parseInt(item.play_count || '0', 10) || 0,
  };
}
async function saavnSearchSongs(q, limit = 8, enrich = true) {
  const j = await rthmx(`/api/songs?q=${encodeURIComponent(q)}`).catch(() => null);
  let items = (j?.results || []).filter(r => r.type !== 'album' && r.type !== 'artist');
  const songOnly = items.filter(r => String(r.perma_url || '').includes('/song/'));
  if (songOnly.length) items = songOnly;
  items = items.slice(0, limit);
  const full = enrich ? await Promise.all(items.map(async (it) => {
    try {
      const d = await rthmx(`/api/song?token=${encodeURIComponent(it.token)}`);
      return { ...it, duration: d?.more_info?.duration || it.duration, more_info: d?.more_info || it.more_info };
    } catch { return it; }
  })) : items;
  return full.map(normalizeSaavnSong).filter(Boolean);
}
async function saavnSearchAlbums(q, limit = 4) {
  const j = await rthmx(`/api/albums?q=${encodeURIComponent(q)}`).catch(() => null);
  const items = (j?.results || j?.albums || []).slice(0, limit);
  return items.map((a) => a?.token ? ({
    id: `saavn:al:${a.token}`, source: 'saavn', sourceId: String(a.token), type: 'album',
    name: a.title || 'Unknown', artist: saavnArtistName(a), image: saavnImage(a.image), year: a.year || '',
    trackCount: parseInt(a.song_count || a.more_info?.song_count || '0', 10) || 0,
  }) : null).filter(Boolean);
}
async function saavnSearchArtists(q, limit = 6) {
  const songs = await saavnSearchSongs(q, 10, false).catch(() => []);
  const seen = new Map();
  for (const t of songs) {
    const n = t.artist?.name || '';
    if (!n || n === 'Unknown') continue;
    const k = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!k || seen.has(k)) continue;
    seen.set(k, { id: `saavn:ar:${slugifyName(n)}`, source: 'saavn', type: 'artist', name: n, image: t.image || '' });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}
async function saavnSongDetail(token) {
  const d = await rthmx(`/api/song?token=${encodeURIComponent(token)}`);
  if (!d?.token) return null;
  return normalizeSaavnSong({ ...d, token: d.token, duration: d?.more_info?.duration });
}
async function saavnAlbumDetail(token) {
  const d = await rthmx(`/api/album?token=${encodeURIComponent(token)}`);
  if (!d) return null;
  const dal = Array.isArray(d.artists) ? d.artists : (d.artists?.primary || []);
  const songs = (d.songs || []).map((s) => normalizeSaavnSong({ ...s, image: s.image || d.image })).filter(Boolean);
  return {
    id: `saavn:al:${token}`, source: 'saavn', sourceId: String(token), type: 'album',
    name: d.title || 'Unknown', artist: dal.map(a => a.name).filter(Boolean).join(', ') || songs[0]?.artist?.name || '',
    image: saavnImage(d.image), year: d.year || '', trackCount: songs.length, description: d.header_desc || '', songs,
  };
}
async function saavnArtistDetail(slug) {
  const name = prettySlug(slug);
  const songs = await saavnSearchSongs(name, 20).catch(() => []);
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  const mine = songs.filter(t => words.some(w => (t.artist?.name || '').toLowerCase().includes(w)))
    .sort((a, b) => ((b.artist?.name || '').toLowerCase() === name.toLowerCase()) - ((a.artist?.name || '').toLowerCase() === name.toLowerCase()))
    .slice(0, 20);
  if (!mine.length) return null;
  const best = mine[0].artist?.name || name;
  return { id: `saavn:ar:${slugifyName(best)}`, source: 'saavn', type: 'artist', name: best, image: mine[0].image || '', topSongs: mine, topAlbums: [], tags: [] };
}

// ---------------- cross-source merge (dedupes same song, keeps mirrors) ----------------
function normKey(title, artist) {
  return `${title || ''}|${artist || ''}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
}
function buildAudioUrl(mirrors) {
  const [p, ...rest] = mirrors;
  return `/api/audio?src=${p.source}&id=${encodeURIComponent(p.sourceId)}` + rest.map(m => `&m=${m.source}:${encodeURIComponent(m.sourceId)}`).join('');
}
// measured cover quality per provider (px): mrj ~1300, dj ~543, saavn 500, djp 300
function imgScore(u) {
  const s = String(u || '');
  if (!s) return 0;
  if (s.includes('mr-jatt.im') || s.includes('pendujatt.pro')) return 4;
  if (s.includes('djjohal.com')) return 3;
  if (s.includes('saavncdn.com')) return 2;
  if (s.includes('djpunjab')) return 1;
  return 0;
}
// round-robin interleave so no single provider crowds the others past the cap
function interleave(lists) {
  const out = [];
  for (let i = 0; ; i++) {
    let any = false;
    for (const l of lists) { if (l && i < l.length) { out.push(l[i]); any = true; } }
    if (!any) break;
  }
  return out;
}
function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function mergeTracks(lists) {
  const seen = new Map();
  const out = [];
  for (const list of lists) {
    for (const t of list || []) {
      if (!t) continue;
      let k = normKey(t.title, t.artist?.name);
      // same name but a clearly different recording (duration differs >10s): keep separate
      if (seen.has(k)) {
        const m0 = seen.get(k);
        if (m0.duration > 0 && t.duration > 0 && Math.abs(m0.duration - t.duration) > 10) {
          k = `${k}#${t.source}:${t.sourceId}`;
        }
      }
      if (seen.has(k)) {
        const m = seen.get(k);
        if (m.mirrors.length < 4 && !m.mirrors.some(x => x.source === t.source && x.sourceId === t.sourceId)) {
          m.mirrors.push({ source: t.source, sourceId: t.sourceId });
        }
        // same song on multiple providers: keep the sharpest cover art
        if (t.image && imgScore(t.image) > imgScore(m.image)) {
          m.image = t.image;
          if (m.album) m.album.image = t.image;
          if (m.artist) m.artist.image = t.image;
        }
        // fill gaps from whichever provider has the metadata
        if (!m.duration && t.duration) m.duration = t.duration;
        if (!m.year && t.year) m.year = t.year;
        if (!m.language && t.language) m.language = t.language;
        if ((t.plays || 0) > (m.plays || 0)) m.plays = t.plays;
        if (t.explicit && !m.explicit) m.explicit = true;
        if (t.album?.name && m.album && !m.album.name) m.album.name = t.album.name;
        if (t.label && !m.label) m.label = t.label;
        continue;
      }
      t.mirrors = [{ source: t.source, sourceId: t.sourceId }];
      seen.set(k, t);
      out.push(t);
    }
  }
  for (const t of out) t.streamUrl = buildAudioUrl(t.mirrors);
  return out;
}

// ---------------- Audius (open network: full streams, no key) ----------------
// Probed 2026-09-17: discovery + search + /stream all live from this box;
// streams 302 to creator nodes and carry full MP3s. User-uploaded catalogue,
// so it mostly adds mirrors for known songs + long-tail coverage.
const AUDIUS_APP = 'SoundWave';
const AUDIUS_HOST = 'https://api.audius.co';
async function audiusSearchSongs(q, limit = 6) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(`${AUDIUS_HOST}/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=${AUDIUS_APP}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`audius HTTP ${r.status}`);
    const j = await r.json();
    const out = [];
    for (const t of j?.data || []) {
      if (!t?.id || !t.title || t.is_streamable === false) continue;
      out.push({
        id: `audius:${t.id}`, source: 'audius', sourceId: String(t.id), type: 'track',
        title: String(t.title).trim(),
        artist: { id: '', name: t.user?.name || 'Unknown', image: t.user?.profile_picture?.['150x150'] || '' },
        artists: [], album: { id: '', name: '', image: '' },
        duration: +t.duration || 0,
        image: t.artwork?.['1000x1000'] || t.artwork?.['480x480'] || t.artwork?.['150x150'] || '',
        streamUrl: `/api/audio?src=audius&id=${t.id}`, previewUrl: '', isPreview: false,
        codec: '', quality: '128', explicit: false, year: '', language: '',
        plays: t.play_count || 0,
      });
      if (out.length >= limit) break;
    }
    return out;
  } finally { clearTimeout(to); }
}

// ---------------- fastest-mirror audio ----------------
const QUALITY_ORDER = { high: ['320', '160', '128', '96', '48'], medium: ['160', '128', '320', '96', '48'], low: ['96', '48', '160', '128', '320'] };
const cdnMs = new Map(); // host -> EWMA latency ms (self-tuning speed rank)
function cdnScore(host) { return cdnMs.get(host) ?? 150; }
function noteCdn(host, ms) {
  const p = cdnMs.get(host);
  cdnMs.set(host, p == null ? ms : p * 0.7 + ms * 0.3);
}
function refererFor(url) {
  const h = (() => { try { return new URL(url).host; } catch { return ''; } })();
  if (h.includes('djpunjab')) return `${DJP_BASE}/`;
  if (h.includes('djjohal') || h.includes('djring')) return `${DJ_BASE}/`;
  if (h.includes('cdnsongs')) return `${MRJ_BASE}/`;
  return null;
}

// ---------------- YouTube Music via InnerTube (Echo's WEB_REMIX recipe) ----------------
// Search/browse work fine from servers; the /player endpoint is bot-walled
// (LOGIN_REQUIRED on every client), so YT tracks play via the closest
// playable mirror resolved from our own sources at first-play time.
const YT_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX3';
async function ytSearchSongs(q, limit = 10) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`https://music.youtube.com/youtubei/v1/search?key=${YT_KEY}&prettyPrint=false`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': DJP_UA, 'X-YouTube-Client-Name': 'WEB_REMIX', 'X-YouTube-Client-Version': '1.20260213.01.00' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20260213.01.00', hl: 'en', gl: 'IN' } }, query: q }),
    });
    if (!r.ok) throw new Error(`yt HTTP ${r.status}`);
    const j = await r.json();
    const out = [], seen = new Set();
    const walk = (o) => {
      if (!o || out.length >= limit) return;
      if (Array.isArray(o)) { for (const v of o) walk(v); return; }
      if (typeof o !== 'object') return;
      const m = o.musicResponsiveListItemRenderer || o.musicTwoRowItemRenderer;
      if (m) {
        const vid = m.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId
          || m.navigationEndpoint?.watchEndpoint?.videoId;
        const cols = m.flexColumns || [];
        const runs = (i) => cols[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const title = runs(0).map(x => x.text).join('') || (m.title?.runs || []).map(x => x.text).join('');
        const sub = runs(1).map(x => x.text).join('') || (m.subtitle?.runs || []).map(x => x.text).join('');
        if (vid && title && !seen.has(vid)) {
          seen.add(vid);
          const raw = sub.split('\u2022').map(s => s.trim()).filter(Boolean);
          const durM = (raw.find(p => /^\d+:\d+$/.test(p)) || '').split(':');
          const parts = raw.filter(p => !/^(song|video|album|single|ep|artist|playlist|podcast|episode)$/i.test(p)
            && !/^\d+:\d+$/.test(p) && !/^\d{4}$/.test(p) && !/views?|plays?/i.test(p));
          out.push({ id: `yt:${vid}`, source: 'yt', sourceId: vid, type: 'track', title: title.trim(),
            artist: { id: '', name: parts[0] || 'Unknown', image: '' }, artists: [],
            album: { id: '', name: '', image: '' },
            duration: durM.length === 2 ? (+durM[0]) * 60 + (+durM[1]) : 0,
            image: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
            streamUrl: `/api/audio?src=yt&id=${vid}`, previewUrl: '', isPreview: false,
            codec: '', quality: 'match', explicit: false, year: '', language: '', plays: 0 });
        }
        return;
      }
      for (const v of Object.values(o)) walk(v);
    };
    walk(j.contents);
    return out;
  } finally { clearTimeout(to); }
}
const ytMatchCache = new Map(); // videoId -> { mirrors: [{ source, sid }], time }
async function ytResolve(title, artist, vid) {
  const hit = ytMatchCache.get(String(vid));
  if (hit && Date.now() - hit.time < PAGE_TTL) return hit.mirrors;
  const q = [title, (artist && artist !== 'Unknown') ? artist : ''].filter(Boolean).join(' ');
  if (!q) return null;
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r([]), ms))]);
  const lists = await Promise.all([
    withTimeout(saavnSearchSongs(q, 3, false).catch(() => []), 12000),
    withTimeout(djpSearchSongs(q, 3).catch(() => []), 12000),
    withTimeout(djSearchSongs(q, 3).catch(() => []), 12000),
    withTimeout(mrjSearchSongs(q, 3).catch(() => []), 12000),
  ]);
  const all = lists.flat().filter(t => t?.sourceId);
  if (!all.length) return null;
  const ft = fold(title), fa = fold((artist && artist !== 'Unknown') ? artist : '');
  const score = (t) => {
    const tt = fold(t.title || ''), ta = fold(t.artist?.name || '');
    return (tt && ft && (tt.includes(ft) || ft.includes(tt)) ? 2 : 0) + (ta && fa && (ta.includes(fa) || fa.includes(ta)) ? 1 : 0);
  };
  all.sort((x, y) => score(y) - score(x));
  // top-3 across distinct sources: tryStream failover survives dead picks
  const seen = new Set(), mirrors = [];
  for (const t of all) {
    if (seen.has(t.source)) continue;
    seen.add(t.source);
    mirrors.push({ source: t.source, sid: String(t.sourceId) });
    if (mirrors.length >= 3) break;
  }
  if (ytMatchCache.size > 500) ytMatchCache.delete(ytMatchCache.keys().next().value);
  ytMatchCache.set(String(vid), { mirrors, time: Date.now() });
  return mirrors;
}
async function resolveMirrorInner(source, sid) {
    if (source === 'djp') {
      const e = (await djpLoadIndex()).get(String(sid));
      if (!e || e.album) return null;
      const pg = await djpSongPage(e.url).catch(() => null);
      if (!pg) return null;
      return pg.mp3s && Object.keys(pg.mp3s).length ? { mp3s: pg.mp3s, page: e.url } : null;
    }
    if (source === 'dj') {
      if (String(sid).startsWith('t:')) {
        // self-contained: numeric id alone rebuilds quality URLs (survives restarts)
        const num = String(sid).slice(2);
        if (!/^\d+$/.test(num)) return null;
        const c = djCustom.get(String(sid));
        return { mp3s: c?.mp3s || djBareMp3s(num) };
      }
      const e = (await djLoadIndex()).get(String(sid).toLowerCase());
      if (!e || e.album) return null;
      const pg = await djSongPage(e.url).catch(() => null);
      if (!pg) return null;
      return pg.mp3s && Object.keys(pg.mp3s).length ? { mp3s: pg.mp3s, page: e.url } : null;
    }
    if (source === 'mrj') {
      const e = (await mrjLoadIndex()).get(String(sid));
      if (!e || e.album) return null;
      const pg = await mrjSongPage(e.url).catch(() => null);
      if (!pg) return null;
      return pg.mp3s && Object.keys(pg.mp3s).length ? { mp3s: pg.mp3s, page: e.url } : null;
    }
    if (source === 'saavn') {
      const urls = await saavnStreamUrls(String(sid)).catch(() => null);
      return urls && Object.keys(urls).length ? { mp3s: urls, type: 'audio/mp4' } : null;
    }
    if (source === 'audius') {
      // /stream 302s to the creator node; tryStream's fetch follows redirects
      return { mp3s: { '128': `${AUDIUS_HOST}/v1/tracks/${encodeURIComponent(String(sid))}/stream?app_name=${AUDIUS_APP}` } };
    }
  return null;
}
async function resolveMirror(source, sid) {
  const h = srcHealth[source];
  if (h && Date.now() < h.until) return null; // circuit open: skip dead source fast
  try {
    const r = await resolveMirrorInner(source, sid);
    if (h) { h.fails = 0; h.until = 0; }
    return r;
  } catch (e) {
    if (h && ++h.fails >= 3) { h.until = Date.now() + 60000; console.error(`[health] ${source} unavailable, skipping for 60s`); }
    return null;
  }
}

const audioCache = new Map(); // key -> { buf, br, time } (LRU: hits refresh recency, TTL by age)
const audioInflight = new Map(); // key -> Promise (owner streams, waiters serve its cache)
let audioHits = 0, audioMiss = 0;
function touchAudio(key) {
  const h = audioCache.get(key);
  if (h) { audioCache.delete(key); audioCache.set(key, h); }
}
function audioCacheSet(key, entry) {
  const old = audioCache.get(key);
  if (old) audioCacheBytes -= old.buf.length;
  audioCache.delete(key);
  audioCache.set(key, entry);
  audioCacheBytes += entry.buf.length;
  const cap = AUDIO_CACHE_MB * 1048576;
  while (audioCache.size > 1 && (audioCache.size > AUDIO_MAX || audioCacheBytes > cap)) {
    const oldest = audioCache.keys().next().value;
    const v = audioCache.get(oldest);
    audioCache.delete(oldest);
    if (v) audioCacheBytes -= v.buf.length;
  }
  if (audioCacheBytes < 0) audioCacheBytes = 0;
}
function waitForAudio(pending, ms) {
  return Promise.race([Promise.resolve(pending).then(() => true), new Promise(r => setTimeout(() => r(false), ms))]);
}
function serveBuf(res, req, buf, cached, br, type = 'audio/mpeg') {
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Audio-Cache', cached ? 'HIT' : 'MISS');
  if (br) res.setHeader('X-Audio-Bitrate', br);
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m?.[1] ? parseInt(m[1], 10) : 0;
    let end = m?.[2] ? parseInt(m[2], 10) : buf.length - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, buf.length - end); end = buf.length - 1; } // suffix: last N bytes
    if (start >= buf.length) {
      res.setHeader('Content-Range', `bytes */${buf.length}`);
      return res.status(416).end();
    }
    const s = Math.min(start, buf.length - 1), e = Math.min(end, buf.length - 1);
    if (s > e) { res.setHeader('Content-Range', `bytes */${buf.length}`); return res.status(416).end(); }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${s}-${e}/${buf.length}`);
    res.setHeader('Content-Length', String(e - s + 1));
    return res.end(buf.subarray(s, e + 1));
  }
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}


// ---------------- self-healing sources: circuit breaker + cross-source recovery ----------------
const srcHealth = { djp: { fails: 0, until: 0 }, dj: { fails: 0, until: 0 }, mrj: { fails: 0, until: 0 }, saavn: { fails: 0, until: 0 }, yt: { fails: 0, until: 0 }, audius: { fails: 0, until: 0 } };
function tripSource(source, ms = 60000) { const h = srcHealth[source]; if (h) { h.fails = 3; h.until = Date.now() + ms; } }
function srcDegraded() { const now = Date.now(); return Object.keys(srcHealth).filter(s => srcHealth[s].until > now); }

function splitArtists(name) {
  return String(name || '').split(/\s*(?:,|;|&|\/|\+|\bfeat\.?\b|\bft\.?\b|\band\b|\bwith\b|\bx\b)\s*/i)
    .map(s => s.trim()).filter(s => s.length > 1 && !/^(various|unknown|artists?)$/i.test(s)).slice(0, 3);
}
const SIM_STOP = new Set(['the', 'a', 'an', 'song', 'songs', 'official', 'audio', 'video', 'lyric', 'lyrics', 'full', 'hd', 'hq', '4k', 'mp3', 'punjabi', 'hindi']);
function titleTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !SIM_STOP.has(w));
}
function overlapScore(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter++; });
  return inter / Math.max(A.size, B.size);
}
function recoveryScore(title, artist, cand) {
  const ct = cand.title || '', ca = cand.artist?.name || '';
  if (normKey(title, artist) === normKey(ct, ca)) return 100;
  let s = overlapScore(titleTokens(title), titleTokens(ct)) * 60;
  const qa = splitArtists(artist).map(x => x.toLowerCase());
  const cla = (ca || '').toLowerCase();
  if (qa.some(n => n && cla.includes(n))) s += 40;
  return s;
}
function audioKey(src, sid, q, t = '', ar = '') {
  return `${src}:${sid}:${q}:${t}|${ar}`.toLowerCase().replace(/[^a-z0-9:|]/g, '');
}
const recoverCache = new Map(); // key -> { mirrors, time }
async function recoverMirrors(title, artist, tried = []) {
  if (artist === 'Unknown') artist = ''; // don't poison the query with a placeholder
  const key = `${title}|${artist}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
  const hit = recoverCache.get(key);
  if (hit && Date.now() - hit.time < 30 * 60 * 1000) return hit.mirrors;
  const q = `${title} ${artist}`.trim();
  const down = new Set(srcDegraded());
  const triedKeys = new Set(tried.map(t => `${t.source}:${t.sid}`));
  const pick = (lists) => {
    let best = null, bestS = 24;
    for (const list of lists) for (const t of list) {
      const s = recoveryScore(title, artist, t);
      if (s > bestS) { bestS = s; best = t; }
    }
    return best ? { best, score: bestS } : null;
  };
  const toMirrors = (lists, best) => {
    const m = mergeTracks(lists).find(t => normKey(t.title, t.artist?.name) === normKey(best.title, best.artist?.name));
    return (m?.mirrors || [{ source: best.source, sourceId: best.sourceId }])
      .map(x => ({ source: x.source, sid: x.sourceId }))
      .filter(x => !triedKeys.has(`${x.source}:${x.sid}`)).slice(0, 4);
  };
  // tier 1: fast API source first (usually enough, ~2s)
  const fast = down.has('saavn') ? [] : await saavnSearchSongs(q, 5, false).catch(() => []);
  let found = pick([fast]);
  let mirrors = [];
  if (found && found.score >= 60) mirrors = toMirrors([fast], found.best);
  else {
    // tier 2: full sweep of remaining sources (reuses tier-1 results)
    const lists = await Promise.all([
      down.has('djp') ? [] : djpSearchSongs(q, 5).catch(() => []),
      down.has('dj') ? [] : djSearchSongs(q, 5).catch(() => []),
      down.has('mrj') ? [] : mrjSearchSongs(q, 5).catch(() => []),
    ]);
    found = pick([fast, ...lists]);
    if (found) mirrors = toMirrors([fast, ...lists], found.best);
  }
  if (recoverCache.size > 200) recoverCache.delete(recoverCache.keys().next().value);
  recoverCache.set(key, { mirrors, time: Date.now() });
  return mirrors;
}

// ---------------- similar songs (same artist + title kin, merged with mirrors) ----------------
const similarCache = new Map(); // key -> { data, time }
function similarRank(title, artist, t) {
  const ca = (t.artist?.name || '').toLowerCase();
  const qa = splitArtists(artist).map(x => x.toLowerCase());
  let s = overlapScore(titleTokens(title), titleTokens(t.title)) * 30;
  if (qa.some(n => n && ca === n)) s += 70;
  else if (qa.some(n => n && (ca.includes(n) || n.includes(ca)))) s += 50;
  return s;
}

// ---------------- recommendations: deep cuts, for-you, time machine ----------------
function fmtPlays(n) {
  n = n || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
function withTimeout(p, ms, fb = null) {
  return Promise.race([Promise.resolve(p).catch(() => fb), new Promise(r => setTimeout(() => r(fb), ms))]);
}
async function artistSongsAll(name) {
  const slug = slugifyName(name);
  const got = (await Promise.all([
    withTimeout(djpArtistDetail(slug), 20000),
    withTimeout(djArtistDetail(slug), 20000),
    withTimeout(mrjArtistDetail(slug), 20000),
    withTimeout(saavnArtistDetail(slug), 20000),
  ])).filter(Boolean);
  const per = { djp: [], dj: [], mrj: [], saavn: [] };
  for (const g of got) for (const t of (g.topSongs || g.songs || [])) if (t?.source && per[t.source]) per[t.source].push(t);
  return mergeTracks([per.djp, per.dj, per.mrj, per.saavn]);
}
app.get('/api/deep-cuts', async (req, res) => {
  const artist = (req.query.artist || '').trim();
  const limit = Math.min(parseInt(req.query.limit || '10', 10) || 10, 15);
  if (!artist) return res.json({ songs: [] });
  const ck = `deep:${artist}`.toLowerCase();
  const hit = getCache(ck);
  if (hit) return res.json({ songs: hit.slice(0, limit) });
  try {
    const songs = await artistSongsAll(splitArtists(artist)[0] || artist);
    const qa = artist.toLowerCase();
    const mine = songs.filter(t => {
      const ca = (t.artist?.name || '').toLowerCase();
      return ca.includes(qa.split(' ')[0]) || qa.includes(ca.split(' ')[0]);
    });
    const withPlays = mine.filter(t => (t.plays || 0) > 0).sort((a, b) => a.plays - b.plays);
    const unknown = mine.filter(t => !(t.plays > 0));
    const data = [...withPlays, ...unknown].slice(0, 15).map(t => ({ ...t, reason: t.plays > 0 ? (t.plays < 2000000 ? `Deep cut · ${fmtPlays(t.plays)} plays` : `From the vault · ${fmtPlays(t.plays)} plays`) : 'Deep cut · rare find' }));
    setCache(ck, data, 60 * 60 * 1000);
    res.json({ songs: data.slice(0, limit) });
  } catch (e) { res.status(502).json({ error: 'Deep cuts failed', detail: e.message }); }
});
async function randomIndexTracks(n = 5) {
  const maps = await warmMaps();
  const pools = maps.filter(([, m]) => m?.size > 50);
  if (!pools.length) return [];
  const cands = [];
  for (let i = 0; i < n * 4 && cands.length < n * 2; i++) {
    const [src, map] = pools[Math.floor(Math.random() * pools.length)];
    const keys = [...map.keys()];
    const e = map.get(keys[Math.floor(Math.random() * keys.length)]);
    if (e && !e.album) cands.push([src, e]);
  }
  const got = (await Promise.all(cands.map(([src, e]) => withTimeout((async () => {
    try {
      const pg = src === 'djp' ? await djpSongPage(e.url) : src === 'dj' ? await djSongPage(e.url) : await mrjSongPage(e.url);
      const t = src === 'djp' ? normalizeDjpSong(e.id, pg) : src === 'dj' ? normalizeDjSong(e.id, pg) : normalizeMrjSong(e.id, pg);
      return t?.title ? t : null;
    } catch { return null; }
  })(), 15000, null)))).filter(Boolean);
  const seen = new Set(), out = [];
  for (const t of got) {
    const k = normKey(t.title, t.artist?.name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...t, reason: 'Adventurous pick · from the deep catalog' });
    if (out.length >= n) break;
  }
  return out;
}
async function similarInternal(title, artist, limit = 8) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/similar?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&limit=${limit}`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) return [];
    return (await r.json())?.songs || [];
  } catch (e) { console.error('similarInternal failed:', e.message); return []; }
}
app.get('/api/for-you', async (req, res) => {
  const mix = Math.min(Math.max(parseInt(req.query.mix || '30', 10) || 0, 0), 100);
  const limit = Math.min(parseInt(req.query.limit || '15', 10) || 15, 24);
  let seeds = [];
  try { seeds = JSON.parse(req.query.seeds || '[]').filter(s => s?.t).slice(0, 3); } catch {}
  const artists = String(req.query.artists || '').split('|').map(s => s.trim()).filter(Boolean).slice(0, 4);
  const ck = `foryou:${mix}:${limit}:${fold(JSON.stringify(seeds))}:${fold(artists.join('|'))}`;
  const hit = getCache(ck);
  if (hit) return res.json({ songs: hit });
  try {
    const advN = Math.round(limit * mix / 100);
    const famN = limit - advN;
    let famLists = [], deepList = [], advList = [];
    const pFam = Promise.all(seeds.map(s => similarInternal(s.t, s.a || '').catch(() => []))).then(r => { famLists = r; }).catch(() => {});
    const pDeep = (async () => {
      const an = splitArtists(seeds[0]?.a || artists[0] || '')[0] || artists[0] || '';
      if (!an) return [];
      const r = await fetch(`http://127.0.0.1:${PORT}/api/deep-cuts?artist=${encodeURIComponent(an)}&limit=5`, { signal: AbortSignal.timeout(60000) }).catch(() => null);
      if (!r?.ok) return [];
      return (await r.json().catch(() => ({})))?.songs || [];
    })().then(r => { deepList = r; }).catch(() => {});
    const pAdv = (advN ? randomIndexTracks(advN + 2).catch(() => []) : Promise.resolve([])).then(r => { advList = r; }).catch(() => {});
    const finished = await Promise.race([Promise.all([pFam, pDeep, pAdv]).then(() => true), new Promise(r => setTimeout(() => r(false), 45000))]);
    if (!finished) console.error(`[for-you] partial after 45s (fam:${famLists.flat().length} deep:${deepList.length} adv:${advList.length})`);
    const perSeedLists = seeds.map((s, i) => (famLists[i] || []).map(t => ({ ...t, reason: `Because you listened to “${s.t}”` })));
    const picked = [];
    for (let r = 0; r < 8 && picked.length < famN; r++)
      for (const L of perSeedLists) { if (L[r]) picked.push(L[r]); if (picked.length >= famN) break; }
    const all = [...picked, ...(deepList || []).slice(0, 3), ...(advList || [])];
    const seen = new Set(), data = [];
    for (const t of all) {
      const k = normKey(t.title, t.artist?.name);
      if (seen.has(k)) continue;
      seen.add(k);
      data.push(t);
      if (data.length >= limit) break;
    }
    setCache(ck, data, 10 * 60 * 1000);
    res.json({ songs: data });
  } catch (e) { res.status(502).json({ error: 'For-you failed', detail: e.message }); }
});

app.get('/api/similar', async (req, res) => {
  const title = (req.query.title || '').trim().slice(0, 200), artist = (req.query.artist || '').trim().slice(0, 200);
  const limit = Math.min(parseInt(req.query.limit || '12', 10) || 12, 24);
  if (!title && !artist) return res.json({ songs: [] });
  const key = `sim:${title}|${artist}`.toLowerCase().replace(/[^a-z0-9|:]/g, '');
  const hit = similarCache.get(key);
  if (hit && Date.now() - hit.time < 60 * 60 * 1000) return res.json({ songs: hit.data.slice(0, limit) });
  try {
    const names = splitArtists(artist).slice(0, 2);
    const jobs = [];
    for (const n of names) {
      const slug = slugifyName(n);
      jobs.push(djpArtistDetail(slug).catch(() => null));
      jobs.push(djArtistDetail(slug).catch(() => null));
      jobs.push(mrjArtistDetail(slug).catch(() => null));
      jobs.push(saavnArtistDetail(slug).catch(() => null));
    }
    const kws = titleTokens(title).slice(0, 2).join(' ');
    if (kws) {
      jobs.push(djpSearchSongs(kws, 4).then(r => ({ topSongs: r })).catch(() => null));
      jobs.push(djSearchSongs(kws, 4).then(r => ({ topSongs: r })).catch(() => null));
      jobs.push(mrjSearchSongs(kws, 4).then(r => ({ topSongs: r })).catch(() => null));
      jobs.push(saavnSearchSongs(kws, 4, false).then(r => ({ topSongs: r })).catch(() => null));
    }
    const got = (await Promise.all(jobs.map(j => withTimeout(j, 20000)))).filter(Boolean);
    const per = { djp: [], dj: [], mrj: [], saavn: [] };
    for (const g of got) for (const t of (g.topSongs || g.songs || [])) if (t?.source && per[t.source]) per[t.source].push(t);
    const merged = mergeTracks([per.djp, per.dj, per.mrj, per.saavn]).filter(t => recoveryScore(title, artist, t) < 60);
    for (const t of merged) t._s = similarRank(title, artist, t);
    merged.sort((a, b) => b._s - a._s);
    const data = merged.slice(0, 24).map(t => { const { _s, ...rest } = t; return rest; });
    if (similarCache.size > 200) similarCache.delete(similarCache.keys().next().value);
    similarCache.set(key, { data, time: Date.now() });
    res.json({ songs: data.slice(0, limit) });
  } catch (e) { res.status(502).json({ error: 'Similar failed', detail: e.message }); }
});

// ---------------- prefetch warmer: fill server audio cache ahead of playback ----------------
const warmInflight = new Map(); // key -> time
// ---------------- YouTube videos (played via the embedded player) ----------------
// Search and metadata only. There is no stream endpoint: YouTube no longer
// returns fetchable stream URLs to a server, so the client embeds the official
// IFrame Player for these tracks. See the header comment in youtube.js.
app.get('/api/yt/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 12));
  try {
    const videos = await ytVideoSearch(q, limit);
    res.json({ videos });
  } catch (e) {
    tripSource('yt');
    res.status(502).json({ error: e?.message || 'YouTube search failed' });
  }
});

app.get('/api/yt/info/:id', async (req, res) => {
  try {
    const track = await ytVideoInfo(req.params.id);
    if (!track) return res.status(404).json({ error: 'Video not found' });
    res.json({ track });
  } catch (e) {
    res.status(502).json({ error: e?.message || 'YouTube lookup failed' });
  }
});

app.get('/api/warm', async (req, res) => {
  const src = req.query.src, sid = req.query.id;
  const q = QUALITY_ORDER[req.query.quality] ? req.query.quality : 'high';
  if (!src || !sid) return res.status(400).json({ error: 'Missing src/id' });
  const key = audioKey(src, sid, q, req.query.t || '', req.query.ar || '');
  const hit = audioCache.get(key);
  if (hit && Date.now() - hit.time < AUDIO_TTL) { touchAudio(key); return res.json({ cached: true }); }
  if (warmInflight.has(key)) return res.status(202).json({ warming: true });
  warmInflight.set(key, Date.now());
  const qs = new URLSearchParams();
  qs.set('src', src); qs.set('id', String(sid)); qs.set('quality', q);
  for (const m of [req.query.m || []].flat()) qs.append('m', String(m));
  if (req.query.t) qs.set('t', String(req.query.t));
  if (req.query.ar) qs.set('ar', String(req.query.ar));
  fetch(`http://127.0.0.1:${PORT}/api/audio?${qs.toString()}`, { signal: AbortSignal.timeout(120000) })
    .then(r => r.arrayBuffer()).catch(() => {}).finally(() => warmInflight.delete(key));
  res.status(202).json({ warming: true });
});

app.get('/api/audio', async (req, res) => {
  const src = req.query.src, sid = req.query.id;
  const q = QUALITY_ORDER[req.query.quality] ? req.query.quality : 'high';
  if (!src || !sid) return res.status(400).json({ error: 'Missing src/id' });
  // fast path: a media element's first request is always the open-ended
  // `bytes=0-` — i.e. the whole file. Treat it as a full request so it owns
  // download dedup and becomes cacheable; concurrent mid-file ranges then
  // HIT instead of each firing their own upstream fetch. Returning 200 to a
  // Range request is legal (server MAY ignore Range); players accept it.
  if (req.headers.range && String(req.headers.range).trim() === 'bytes=0-') {
    delete req.headers.range;
  }
  const ms = [req.query.m || []].flat().map(s => {
    const i = String(s).indexOf(':');
    return i > 0 ? { source: s.slice(0, i), sid: s.slice(i + 1) } : null;
  }).filter(Boolean);
  const recT = (req.query.t || '').trim(), recAr = (req.query.ar || '').trim();
  // YouTube Music results carry no playable stream (InnerTube /player is
  // bot-walled from servers) — resolve to the closest playable mirror.
  let effSrc = src, effSid = String(sid), isYtMatch = false, ytMirrors = null;
  if (src === 'yt') {
    ytMirrors = await ytResolve(recT, recAr, String(sid)).catch(() => null);
    if (!ytMirrors?.length) return res.status(502).json({ error: 'No playable match found' });
    effSrc = ytMirrors[0].source; effSid = ytMirrors[0].sid; isYtMatch = true;
  }
  const mirrors = (ytMirrors || [{ source: effSrc, sid: effSid }]).concat(ms).slice(0, 4);
  const key = audioKey(effSrc, effSid, q, recT, recAr);
  const hit = audioCache.get(key);
  if (hit && Date.now() - hit.time < AUDIO_TTL) { touchAudio(key); audioHits++; return serveBuf(res, req, hit.buf, true, hit.br, hit.type || 'audio/mpeg'); }
  audioMiss++;
  // download dedup: concurrent identical requests share ONE upstream fetch.
  // First full request owns (proxies + caches); others wait, then serve its
  // cache. Range requests never own (206s aren't cacheable) but may wait.
  const wantRangeEarly = !!req.headers.range;
  let releaseOwn = null;
  const pending = audioInflight.get(key);
  if (pending) {
    const settled = await waitForAudio(pending, wantRangeEarly ? 8000 : 100000);
    const h2 = audioCache.get(key);
    if (settled && h2 && Date.now() - h2.time < AUDIO_TTL) { touchAudio(key); audioHits++; return serveBuf(res, req, h2.buf, true, h2.br, h2.type || 'audio/mpeg'); }
  } else if (!wantRangeEarly) {
    audioInflight.set(key, new Promise((resolve) => { releaseOwn = () => { audioInflight.delete(key); resolve(true); }; }));
  }
  // hard bounds: an unbounded scrape hang must never wedge the inflight key forever
  const bounded = (p, ms, fb) => Promise.race([p, new Promise(r => setTimeout(() => r(fb), ms))]);
  try {
    const resolved = (await Promise.all(mirrors.map(async m => ({ ...m, r: await bounded(resolveMirror(m.source, m.sid), 25000, null).catch(() => null) })))).filter(x => x.r);
    // (no early return: empty lists fall through to cross-source recovery below)
    const order = QUALITY_ORDER[q];
    const hostOf = (m) => {
      for (const br of order) {
        const u = m.r.mp3s[br];
        if (u) { try { return new URL(u).host; } catch { return ''; } }
      }
      return '';
    };
    const tryStream = async (list, recovered = false) => {
    const tSeek = Date.now();
    const ranked = [...list].sort((a, b) => cdnScore(hostOf(a)) - cdnScore(hostOf(b)));
    const wantRange = !!req.headers.range;
    for (const br of order) {
      for (const m of ranked) {
        const urls = [m.r.mp3s[br] || []].flat().filter(Boolean);
        for (const url of urls) {
        // aggregate seeking budget: N stalled candidates x 20s races must
        // not stack into minutes — give up to cross-source recovery instead
        if (Date.now() - tSeek > 45000) return false;
        const t0 = Date.now();
        const ctrl = new AbortController();
        let reader = null;
        // TTFB budget first (dead mirrors fail fast to the next candidate),
        // then a rolling activity budget: 25s of silence mid-stream = dead socket.
        // (No total cap: slow-but-moving streams must survive for thin clients.)
        let to = setTimeout(() => ctrl.abort(), 20000);
        const bumpActivity = () => {
          clearTimeout(to);
          to = setTimeout(() => { try { reader?.cancel(); } catch {} ctrl.abort(); }, 25000);
        };
        try {
          const up = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': DJP_UA, ...(refererFor(url) ? { Referer: refererFor(url) } : {}), ...(wantRange ? { Range: req.headers.range } : {}) },
          });
          clearTimeout(to);
          if ((up.status !== 200 && up.status !== 206) || !up.body) continue;
          if (wantRange && up.status !== 206) continue; // range-ignoring mirror: skip
          noteCdn(new URL(url).host, Date.now() - t0);
          res.status(up.status);
          res.setHeader('Content-Type', m.r.type || 'audio/mpeg');
          const len = up.headers.get('content-length');
          if (len) res.setHeader('Content-Length', len);
          const cr = up.headers.get('content-range');
          if (cr) res.setHeader('Content-Range', cr);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.setHeader('X-Audio-Cache', 'MISS');
          res.setHeader('X-Audio-Bitrate', br);
          res.setHeader('X-Audio-Mirror', m.source);
          if (recovered) res.setHeader('X-Audio-Recovered', '1');
          reader = up.body.getReader();
          // every read is raced: cancel()/abort() alone can't be trusted to
          // reject a read() parked on a wedged socket (it hangs forever)
          const readRaced = (ms) => new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('stall')), ms);
            reader.read().then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
          });
          // pre-commit: the first chunk must arrive or we fail over to the
          // next mirror with headers still unsent (a stalled first mirror
          // used to wedge the whole response after committing 200+headers)
          let first;
          try { first = await readRaced(20000); }
          catch { clearTimeout(to); try { reader.cancel(); } catch {} ctrl.abort(); continue; }
          if (first.done || !first.value?.length) { try { reader.cancel(); } catch {} ctrl.abort(); continue; }
          let chunks = up.status === 200 ? [] : null;
          let received = 0, aborted = false;
          // 'close' also fires on normal completion — only a pre-finish close is an abort
          const onClose = () => { if (!res.writableEnded) { aborted = true; try { reader.cancel(); } catch {} } };
          req.on('close', onClose);
          // ONE shared close-resolver for every backpressure wait below —
          // a per-chunk req.once('close') trips MaxListeners on big files
          let closedResolve = null;
          const closedP = new Promise((r) => { closedResolve = r; });
          const onClosedDone = () => { try { closedResolve(); } catch {} };
          req.once('close', onClosedDone);
          const writeChunk = async (value) => {
            received += value.length;
            if (chunks) { if (received > 20 * 1024 * 1024) chunks = null; else chunks.push(value); }
            if (aborted) return;
            let okWrite = true;
            try { okWrite = res.write(value); } catch { aborted = true; return; }
            // backpressure wait must also resolve on client disconnect,
            // or this handler (and its inflight key) hangs forever
            if (!okWrite && !aborted) await Promise.race([new Promise((r) => res.once('drain', r)), closedP]);
          };
          bumpActivity();
          try {
            await writeChunk(first.value);
            while (!aborted) {
              const { done, value } = await readRaced(25000);
              if (done) break;
              bumpActivity();
              await writeChunk(value);
            }
          } finally {
            clearTimeout(to);
            req.removeListener('close', onClose);
            req.removeListener('close', onClosedDone);
          }
          if (aborted) { try { res.destroy(); } catch {} return true; } // client gone: nothing to cache
          try { res.end(); } catch {}
          const expected = len ? parseInt(len, 10) : 0;
          if (chunks && received > 100000 && (!expected || received === expected)) {
            audioCacheSet(key, { buf: Buffer.concat(chunks), br, time: Date.now(), type: m.r.type || 'audio/mpeg' });
          }
          return true;
        } catch {
          clearTimeout(to);
          // mid-stream death AFTER headers went out: destroy the response so the
          // client sees a clean connection error (its retry path) instead of a hang
          if (res.headersSent && !res.writableEnded) { try { res.destroy(); } catch {} return true; }
          /* else: next candidate */
        }
        }
      }
    }
    return false;
    };
    if (await tryStream(resolved, isYtMatch)) return;
    if (recT) {
      const rec = await bounded(recoverMirrors(recT, recAr, mirrors).catch(() => []), 45000, []);
      if (rec.length) {
        const resolvedRec = (await Promise.all(rec.map(async m => ({ ...m, r: await resolveMirror(m.source, m.sid) })))).filter(x => x.r);
        if (resolvedRec.length && await tryStream(resolvedRec, true)) return;
      }
    }
    // total failure: bust the cached song pages so the next attempt re-scrapes
    // fresh URLs instead of replaying the same dead links for 6 hours
    try {
      for (const m of resolved) {
        if (m?.r?.page) pageCacheDel(m.r.page);
        if (m?.source === 'saavn' && m?.sid) saavnUrlCache.delete(String(m.sid));
      }
    } catch { /* noop */ }
    if (!res.headersSent) res.status(502).json({ error: 'All mirrors failed' });
  } catch (e) { if (!res.headersSent) res.status(502).json({ error: 'Audio failed', detail: e.message }); }
  finally { try { releaseOwn?.(); } catch { /* noop */ } }
});

// ---------------- Tidal FLAC previews (instant starter while full MP3 loads) ----------------
const TIDAL_CID = process.env.TIDAL_CLIENT_ID || 'txNoH4kkV41MfH25';
const TIDAL_SECRET = process.env.TIDAL_CLIENT_SECRET || 'dQjy0MinCEvxi1O4UmxvxWnDjt4cgHBPw8ll6nYBk98=';
let tidalTok = null, tidalTokExp = 0, tidalTokPromise = null;
async function tidalToken(force = false) {
  if (!force && tidalTok && Date.now() < tidalTokExp) return tidalTok;
  if (!tidalTokPromise) {
    tidalTokPromise = (async () => {
      const body = new URLSearchParams({ client_id: TIDAL_CID, client_secret: TIDAL_SECRET, grant_type: 'client_credentials' });
      const r = await fetch('https://auth.tidal.com/v1/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${TIDAL_CID}:${TIDAL_SECRET}`).toString('base64') },
        body, signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`Tidal token HTTP ${r.status}`);
      const j = await r.json();
      if (!j.access_token) throw new Error('Tidal token missing');
      tidalTok = j.access_token;
      tidalTokExp = Date.now() + ((j.expires_in || 3600) - 60) * 1000;
      return tidalTok;
    })().finally(() => { tidalTokPromise = null; });
  }
  return tidalTokPromise;
}
async function tidalFetch(path, timeout = 20000, retry = true) {
  const tok = await tidalToken();
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`https://api.tidal.com${path}${sep}countryCode=US`, { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': 'SoundWave/1.0' }, signal: AbortSignal.timeout(timeout) });
  if (r.status === 401 && retry) { await tidalToken(true); return tidalFetch(path, timeout, false); }
  if (!r.ok) throw new Error(`Tidal HTTP ${r.status} for ${path}`);
  return r.json();
}
const tidalAudioCache = new Map();
async function tidalStitchedAudio(id) {
  const hit = tidalAudioCache.get(String(id));
  if (hit && Date.now() - hit.time < 15 * 60 * 1000) return hit.buf;
  const j = await tidalFetch(`/v1/tracks/${encodeURIComponent(id)}/playbackinfo?audioquality=HI_RES_LOSSLESS&playbackmode=STREAM&assetpresentation=FULL`, 30000);
  const b64 = j?.manifest;
  if (!b64) throw new Error(j?.userMessage || 'No manifest');
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
  if (tidalAudioCache.size > 6) tidalAudioCache.delete(tidalAudioCache.keys().next().value);
  tidalAudioCache.set(String(id), { buf, time: Date.now() });
  return buf;
}
// Deezer's open search (server-side only — their CORS blocks browsers) as a
// second instant-preview net: 30s preview MP3s when Tidal has no match.
// Probed 2026-09-17: search + preview CDN both reachable from this box.
async function deezerPreview(title, artist) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(`${title} ${artist}`.trim())}&limit=6`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const items = (await r.json())?.data || [];
    let best = null, bestS = 0;
    for (const t of items) {
      const s = tpScore(title, artist, t.title || '', t.artist?.name || '');
      if (s > bestS) { bestS = s; best = t; }
    }
    if (!best || bestS < 0.5 || !best.preview) return null;
    const pr = await fetch(best.preview, { signal: ctrl.signal });
    if (!pr.ok) return null;
    return Buffer.from(await pr.arrayBuffer());
  } finally { clearTimeout(to); }
}

function tpScore(qt, qa, tt, ta) {
  const w = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(x => x.length > 1));
  const A = w(`${qt} ${qa}`), B = w(`${tt} ${ta}`);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter++; });
  return inter / Math.max(A.size, B.size);
}
const tidalPreviewCache = new Map(), tidalPreviewNeg = new Map();
app.get('/api/tidal-preview', async (req, res) => {
  const title = (req.query.title || '').trim(), artist = (req.query.artist || '').trim();
  if (!title) return res.status(400).json({ error: 'Missing title' });
  const key = `${title}|${artist}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
  const hit = tidalPreviewCache.get(key);
  if (hit && Date.now() - hit.time < 30 * 60 * 1000) return serveBuf(res, req, hit.buf, true, hit.br || 'FLAC', hit.type || 'audio/mp4');
  const neg = tidalPreviewNeg.get(key);
  if (neg && Date.now() - neg < 3600000) return res.status(404).json({ error: 'No preview match' });
  let buf = null, br = 'FLAC', type = 'audio/mp4';
  try {
    const j = await tidalFetch(`/v1/search/tracks?query=${encodeURIComponent(`${title} ${artist}`.trim())}&limit=5`, 15000);
    const items = j?.items || [];
    let best = null, bestS = 0;
    for (const t of items) {
      const s = tpScore(title, artist, t.title || '', (t.artists || []).map(a => a.name).join(' '));
      if (s > bestS) { bestS = s; best = t; }
    }
    if (best && bestS >= 0.45) buf = await tidalStitchedAudio(best.id);
  } catch { /* tidal down or no match — the Deezer net below still applies */ }
  if (!buf) {
    const dz = await deezerPreview(title, artist).catch(() => null);
    if (dz) { buf = dz; br = 'DEEZER'; type = 'audio/mpeg'; }
  }
  if (!buf) {
    if (tidalPreviewNeg.size > 500) tidalPreviewNeg.clear();
    tidalPreviewNeg.set(key, Date.now());
    return res.status(404).json({ error: 'No preview match' });
  }
  if (tidalPreviewCache.size >= 8) tidalPreviewCache.delete(tidalPreviewCache.keys().next().value);
  tidalPreviewCache.set(key, { buf, time: Date.now(), br, type });
  serveBuf(res, req, buf, false, br, type);
});

// ---------------- API ----------------
mountAuth(app); // Google sign-in: /api/auth/config, /google, /me, /logout

app.get('/api/health', (req, res) => res.json({
  ok: true, sources: ['djpunjab', 'djjohal', 'mr-jatt', 'pendujatt'], time: new Date().toISOString(),
  uptimeSec: Math.round(process.uptime()),
  memMB: Math.round(process.memoryUsage().heapUsed / 1048576),
  indexes: { djp: djpIndex.size, dj: djIndex.size, mrj: mrjIndex.size },
  caches: { api: cache.size, pages: djpPageCache.size, audio: audioCache.size, audioMB: Math.round(audioCacheBytes / 1048576) },
  audio: { hits: audioHits, misses: audioMiss, inflight: audioInflight.size },
  outbound: { active: outActive, queued: outQueue.length },
  degraded: srcDegraded(),
}));

app.get('/api/sources', async (req, res) => {
  const out = {};
  try { const m = await djpLoadIndex(); out.djpunjab = m.size > 100 ? 'ok' : 'empty'; out.djpunjab_index = m.size; }
  catch (e) { out.djpunjab = `down: ${e.message}`; tripSource('djp'); }
  try { const m = await djLoadIndex(); out.djjohal = m.size > 1000 ? 'ok' : 'empty'; out.djjohal_index = m.size; }
  catch (e) { out.djjohal = `down: ${e.message}`; tripSource('dj'); }
  try { const m = await mrjLoadIndex(); out.mrjatt = m.size > 1000 ? 'ok' : 'empty'; out.mrjatt_index = m.size; }
  catch (e) { out.mrjatt = `down: ${e.message}`; tripSource('mrj'); }
  out.pendujatt = 'mirror';
  try { const t = await rthmx('/api/songs?q=test'); out.saavn = t?.results ? 'ok' : 'empty'; } catch (e) { out.saavn = `down: ${e.message}`; tripSource('saavn'); }
  try { await tidalToken(); out.tidal = 'ok (preview only)'; } catch (e) { out.tidal = `down: ${e.message}`; }
  try {
    const ar = await fetch(`${AUDIUS_HOST}/v1/tracks/trending?app_name=${AUDIUS_APP}&limit=1`, { signal: AbortSignal.timeout(6000) });
    out.audius = ar.ok ? 'ok (full streams)' : `down: ${ar.status}`;
  } catch (e) { out.audius = `down: ${e.message}`; tripSource('audius'); }
  try {
    const dr = await fetch('https://api.deezer.com/search?q=test&limit=1', { signal: AbortSignal.timeout(6000) });
    out.deezer = dr.ok ? 'ok (previews)' : `down: ${dr.status}`;
  } catch (e) { out.deezer = `down: ${e.message}`; }
  out.cdn = Object.fromEntries([...cdnMs.entries()].map(([h, ms]) => [h, Math.round(ms)]));
  out.uptime = Math.round(process.uptime());
  out.degraded = srcDegraded();
  res.json(out);
});


// ---------------- smart search: suggest + fuzzy + NL + filters ----------------
function lev2(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 2) return 3;
  let prev = [], cur = [];
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = 99;
    for (let j = 1; j <= lb; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > 2) return 3;
    [prev, cur] = [cur, prev];
  }
  return prev[lb];
}
async function warmMaps() {
  const race = (p) => Promise.race([p.catch(() => new Map()), new Promise(r => setTimeout(() => r(new Map()), 800))]);
  const [a, b, c] = await Promise.all([race(djpLoadIndex()), race(djLoadIndex()), race(mrjLoadIndex())]);
  return [['djp', a], ['dj', b], ['mrj', c]];
}
function scoreSuggestText(padded, tokens) {
  const words = padded.split(' ').filter(Boolean);
  let score = 0;
  for (const t of tokens) {
    if (padded.includes(` ${t} `)) score += 3;
    else if (words.some(w => w.startsWith(t))) score += 2;
    else if (padded.includes(t)) score += 1;
    else if (t.length >= 4) {
      const cand = words.filter(w => w.length >= 4 && w.slice(0, 2) === t.slice(0, 2));
      if (cand.some(w => lev2(w, t) <= 2)) score += 1;
      else score -= 4;
    }
    else score -= 4;
  }
  return score;
}
async function scanSuggest(q, limit = 8) {
  const tokens = queryWords(q);
  if (!tokens.length) return { songs: [], albums: [] };
  const maps = await warmMaps();
  const out = [];
  const seen = new Set();
  for (const [src, map] of maps) {
    if (!map?.size) continue;
    for (const [, e] of map) {
      const text = fold(String(e.slug || '').replace(/-/g, ' '));
      if (!text || seen.has(text)) continue;
      const score = scoreSuggestText(` ${text} `, tokens);
      if (score <= 0) continue;
      seen.add(text);
      const pretty = prettySlug(e.slug).slice(0, 60);
      out.push({ score, kind: e.album ? 'album' : 'song', text: pretty, q: pretty, source: src });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return { songs: out.filter(o => o.kind === 'song').slice(0, limit), albums: out.filter(o => o.kind === 'album').slice(0, Math.max(2, limit >> 1)) };
}
async function suggestCorrection(q) {
  const { songs, albums } = await scanSuggest(q, 3);
  const top = [...songs, ...albums].sort((a, b) => b.score - a.score)[0];
  if (!top) return '';
  return fold(top.q) === fold(q) ? '' : top.q;
}
const suggestArtists = new Map();
['ap dhillon', 'diljit dosanjh', 'karan aujla', 'shubh', 'guru randhawa', 'jasmine sandlas', 'tulsi kumar', 'prem dhillon', 'sidhu moose wala', 'amrit maan', 'jordan sandhu', 'nimrat khaira'].forEach(n => suggestArtists.set(n, { name: n.replace(/\b\w/g, c => c.toUpperCase()), image: '' }));
function addSuggestArtist(name, image) {
  const k = fold(name).trim();
  if (!k || k === 'unknown' || suggestArtists.size > 500) return;
  if (!suggestArtists.has(k)) suggestArtists.set(k, { name, image: image || '' });
}
app.get('/api/suggest', async (req, res) => {
  const q = (req.query.q || '').trim().slice(0, 200);
  const limit = Math.min(parseInt(req.query.limit || '8', 10) || 8, 12);
  if (q.length < 2) return res.json({ songs: [], albums: [], artists: [] });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const { songs, albums } = await scanSuggest(q, limit);
    const fq = fold(q);
    const artists = [...suggestArtists.values()]
      .filter(a => fold(a.name).includes(fq))
      .slice(0, 4).map(a => ({ kind: 'artist', text: a.name, q: a.name, image: a.image || '' }));
    const payload = { songs, albums, artists };
    setCache(req.originalUrl, payload);
    res.json(payload);
  } catch (e) { res.json({ songs: [], albums: [], artists: [] }); }
});

const MOODS = ['sad', 'happy', 'upbeat', 'chill', 'relax', 'calm', 'energetic', 'energy', 'workout', 'gym', 'running', 'party', 'dance', 'sleep', 'study', 'focus', 'romantic', 'angry', 'loud', 'soft', 'meditation', 'morning', 'night', 'drive', 'driving', 'road trip', 'travel', 'rain', 'rainy', 'wedding'];
const FILLER = /\b(songs?|music|tracks?|tunes?|hits?|numbers?|please|for me|for|by|me|some|any|play|playing|listen|listening|to|the|a)\b/gi;
function parseNL(input) {
  const original = String(input || '').trim();
  const nl = { original };
  const mLike = original.match(/(?:songs?\s+that\s+sound\s+like|sounds?\s+like|similar\s+to|like)\s+(.+)/i);
  if (mLike && mLike[1].trim().length > 1) {
    nl.mode = 'similar';
    nl.ref = mLike[1].replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
    return nl;
  }
  const mDec = fold(original).match(/\b(19[0-9]0s|20[0-4]0s|90s|80s|70s)\b/);
  const mYr = fold(original).match(/\b((?:19|20)\d{2})\b/);
  if (mDec) { let d = mDec[1]; if (/^\d0s$/.test(d)) d = '19' + d; nl.year = d; }
  else if (mYr) nl.year = mYr[1];
  if (/\b(new|latest|fresh)\b/i.test(original) && /(song|music|release|hit|drop)/i.test(original)) {
    nl.note = 'For the newest drops, check the New Drops rail on Home.';
  }
  let q = original;
  const mBy = q.match(/^(?:play\s+)?(?:songs?\s+)?by\s+(.+)/i);
  if (mBy) q = mBy[1];
  q = q.replace(/^(play|listen to)\s+/i, '');
  const mood = MOODS.find(m => new RegExp(`\\b${m}\\w*\\b`).test(fold(q)));
  let cleaned = q.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/\b(19\d{2}|20[0-2]\d|19[0-9]0s|20[0-4]0s|90s|80s|70s)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned && cleaned.toLowerCase() !== original.toLowerCase()) nl.cleaned = cleaned;
  if (mood) {
    const cap = mood.replace(/\b\w/g, c => c.toUpperCase());
    let stripped = cleaned;
    for (const m of MOODS) stripped = stripped.replace(new RegExp(`\\b${m}\\w*\\b`, 'gi'), ' ');
    stripped = stripped.replace(/\s+/g, ' ').trim();
    if (!stripped) { nl.unsupported = true; nl.mood = cap; nl.cleaned = ''; nl.note = `Mood (“${cap}”) isn't searchable yet — we don't have mood data. Try an artist, song, or year.`; }
    else { nl.cleaned = stripped; nl.note = ((nl.note ? nl.note + ' ' : '') + `Mood (“${cap}”) isn't searchable yet — showing matches for “${stripped}”.`); }
  } else if (nl.year && cleaned) nl.note = ((nl.note ? nl.note + ' ' : '') + `Filtered to ${nl.year}.`);
  else if (nl.year && !cleaned) { nl.unsupported = true; nl.note = 'Year-only browsing isn\'t available yet — add an artist or song title (e.g. “AP Dhillon 2021”).'; }
  return nl;
}
async function nlSimilar(ref) {
  const lists = await Promise.all([
    djpSearchSongs(ref, 3).catch(() => []),
    djSearchSongs(ref, 3).catch(() => []),
    mrjSearchSongs(ref, 3).catch(() => []),
    saavnSearchSongs(ref, 3, false).catch(() => []),
  ]);
  const hit = mergeTracks(lists)[0];
  if (!hit?.title) return null;
  const r = await fetch(`http://127.0.0.1:${PORT}/api/similar?title=${encodeURIComponent(hit.title)}&artist=${encodeURIComponent(hit.artist?.name || '')}&limit=20`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j?.songs?.length) return null;
  return { songs: j.songs, refLabel: `${hit.title} — ${hit.artist?.name || ''}`.trim() };
}
function passYear(y, f) {
  if (!f) return true;
  const yy = String(y || '').trim();
  if (!yy) return true;
  const m4 = yy.match(/(19|20)\d{2}/);
  const yr = m4 ? parseInt(m4[0], 10) : 0;
  if (!yr) return true;
  const dm = String(f).match(/^(19\d0|20[0-4]0)s?$/);
  if (dm) { const d = parseInt(dm[1], 10); return yr >= d && yr < d + 10; }
  const ym = String(f).match(/^((?:19|20)\d{2})$/);
  if (ym) return yr === parseInt(ym[1], 10);
  return true;
}
function passFilters(t, f) {
  if (!passYear(t.year, f.y)) return false;
  const d = t.duration || 0;
  if (f.minD && d < f.minD) return false;
  if (f.maxD && (!d || d > f.maxD)) return false;
  if (f.lang && t.language && String(t.language).toLowerCase() !== f.lang) return false;
  if (f.clean && t.explicit) return false;
  return true;
}

// ---------------- complete cross-provider artist discography ----------------
function artistNameMatch(name, words) {
  const n = normName(name);
  return !!n && words.every(w => n.includes(w));
}
// scrape providers: page artist sometimes unparseable ('Unknown') — the slug
// already matched every artist word, so keep those instead of dropping them
function scrapeKeep(t, words) {
  const n = t?.artist?.name || '';
  return !n || n === 'Unknown' || artistNameMatch(n, words);
}
async function djpArtistSongs(name, budget = 60) {
  const words = normName(name).split(' ').filter(w => w.length > 1);
  if (!words.length) return { songs: [], matched: 0, scanned: 0 };
  const idx = await djpLoadIndex().catch(() => new Map());
  // provider's own curated list first (djp's sitemap index is small)
  const topIds = [];
  try {
    const html = await fetchText(`${DJP_BASE}/artist/${slugifyName(name)}-top-songs`, { timeout: 15000, referer: `${DJP_BASE}/` });
    for (const m of html.matchAll(/href="([^"]*?mp3-song-(\d+)\.html)"/gi)) {
      topIds.push([m[2], (m[1].startsWith('http') ? m[1] : DJP_BASE + m[1]).replace(/&amp;/g, '&')]);
    }
  } catch { /* index scan below */ }
  const hits = [];
  for (const [id, e] of idx) {
    if (e.album) continue;
    if (words.every(w => String(e.slug || '').includes(w))) hits.push([id, e.url]);
  }
  let all = [...new Map([...topIds, ...hits]).entries()];
  if (all.length < 15 && words.length > 1 && idx.size) {
    // loose fallback: most distinctive word (usually the surname), post-filter keeps precision
    const w0 = [...words].sort((a, b) => b.length - a.length)[0];
    const loose = [];
    for (const [id, e] of idx) {
      if (e.album) continue;
      if (String(e.slug || '').includes(w0)) loose.push([id, e.url]);
    }
    all = [...new Map([...all, ...loose]).entries()];
  }
  const uniq = all.slice(0, budget);
  const songs = (await Promise.all(uniq.map(async ([id, u]) => {
    try { return normalizeDjpSong(id, await djpSongPage(u)); } catch { return null; }
  }))).filter(Boolean).filter(t => scrapeKeep(t, words));
  return { songs, matched: all.length, scanned: uniq.length };
}
async function djArtistSongs(name, budget = 80) {
  const words = normName(name).split(' ').filter(w => w.length > 1);
  if (!words.length) return { songs: [], matched: 0, scanned: 0 };
  const idx = await djLoadIndex().catch(() => new Map());
  const hits = [];
  for (const [key, e] of idx) {
    if (e.album) continue;
    if (words.every(w => String(e.slug || '').includes(w))) hits.push(key);
  }
  const uniq = [...new Set(hits)].slice(0, budget);
  const songs = (await Promise.all(uniq.map(async s => {
    try {
      const e = idx.get(s);
      if (!e) return null;
      return normalizeDjSong(s, await djSongPage(e.url));
    } catch { return null; }
  }))).filter(Boolean).filter(t => scrapeKeep(t, words));
  return { songs, matched: hits.length, scanned: uniq.length };
}
async function mrjArtistSongs(name, budget = 80) {
  const words = normName(name).split(' ').filter(w => w.length > 1);
  if (!words.length) return { songs: [], matched: 0, scanned: 0 };
  const idx = await mrjLoadIndex().catch(() => new Map());
  const hits = [];
  for (const [key, e] of idx) {
    if (e.album) continue;
    if (words.every(w => String(e.slug || '').toLowerCase().includes(w))) hits.push(String(key));
  }
  const uniq = [...new Set(hits)].slice(0, budget);
  const songs = (await Promise.all(uniq.map(async sid => {
    try {
      const e = idx.get(sid);
      if (!e) return null;
      return normalizeMrjSong(sid, await mrjSongPage(e.url));
    } catch { return null; }
  }))).filter(Boolean).filter(t => scrapeKeep(t, words));
  return { songs, matched: hits.length, scanned: uniq.length };
}
async function saavnArtistSongs(name, budget = 60) {
  const words = normName(name).split(' ').filter(w => w.length > 1);
  if (!words.length) return { songs: [], matched: 0, scanned: 0 };
  const [searched, albums] = await Promise.all([
    saavnSearchSongs(name, 20).catch(() => []),
    saavnSearchAlbums(name, 8).catch(() => []),
  ]);
  const pool = searched.filter(t => artistNameMatch(t.artist?.name, words));
  // album deepening: Saavn search caps at 20 — pull the artist's albums for the rest
  const details = await Promise.all((albums || []).slice(0, 6).map(a => saavnAlbumDetail(a.sourceId).catch(() => null)));
  for (const d of details) {
    if (!d) continue;
    for (const s of (d.songs || [])) {
      if (artistNameMatch(s.artist?.name, words)) pool.push(s);
    }
  }
  const seen = new Set(), out = [];
  for (const t of pool) {
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= budget) break;
  }
  return { songs: out, matched: pool.length, scanned: pool.length };
}
// every song by one artist, merged across ALL providers (mirrors kept for failover)
app.get('/api/artist-songs', async (req, res) => {
  const name = (req.query.name || '').trim().slice(0, 200);
  if (!name) return res.json({ songs: [], perProvider: {}, totalMatched: 0, truncated: false, name: '' });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const legs = (await Promise.all([
      safeSearch(djpArtistSongs(name), 42000),
      safeSearch(djArtistSongs(name), 42000),
      safeSearch(mrjArtistSongs(name), 42000),
      safeSearch(saavnArtistSongs(name), 42000),
    ])).map(x => Array.isArray(x) ? { songs: [], matched: 0, scanned: 0, timedOut: true } : x);
    const [D, J, M, S] = legs;
    const CAP = 200;
    const merged = mergeTracks([interleave([D.songs, J.songs, M.songs, S.songs])]);
    const payload = {
      name,
      songs: merged.slice(0, CAP),
      perProvider: { djp: D.songs.length, dj: J.songs.length, mrj: M.songs.length, saavn: S.songs.length },
      matchedBy: { djp: D.matched, dj: J.matched, mrj: M.matched, saavn: S.matched },
      totalMatched: D.matched + J.matched + M.matched + S.matched,
      truncated: merged.length > CAP || legs.some(l => l.scanned < l.matched),
      ...(legs.some(l => l.timedOut) ? { partial: true } : {}),
    };
    setCache(req.originalUrl, payload, 15 * 60 * 1000);
    res.json(payload);
  } catch (e) { res.status(502).json({ error: 'Artist songs failed', detail: e.message }); }
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim().slice(0, 200);
  const type = (req.query.type || 'all').toLowerCase();
  if (!q) return res.json({ songs: [], albums: [], artists: [] });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  const nl = parseNL(q);
  if (nl.mode === 'similar' && nl.ref) {
    const likeRes = await nlSimilar(nl.ref).catch(() => null);
    if (likeRes?.songs?.length) {
      nl.refLabel = likeRes.refLabel;
      const payload = { songs: likeRes.songs, albums: [], artists: [], nl };
      setCache(req.originalUrl, payload);
      return res.json(payload);
    }
    nl.note = `Couldn't find “${nl.ref}” — showing text matches instead.`;
    nl.mode = null;
  }
  const effQ = nl.unsupported ? '' : (nl.cleaned || q);
  if (nl.unsupported && !effQ) {
    const payload = { songs: [], albums: [], artists: [], nl };
    setCache(req.originalUrl, payload);
    return res.json(payload);
  }
  const yF = (req.query.y || '').trim().toLowerCase();
  const minD = parseInt(req.query.minD || '0', 10) || 0;
  const maxD = parseInt(req.query.maxD || '0', 10) || 0;
  const langF = (req.query.lang || '').trim().toLowerCase();
  const expF = (req.query.exp || '').trim().toLowerCase();
  const effY = nl.year || yF;
  try {
    let songs = [], albums = [], artists = [], youtube = [], ytVideos = [];
    if (type === 'all' || type === 'artists') {
      const [a, b, c, s] = await Promise.all([
        safeSearch(djpSearchArtists(effQ, 6), 20000),
        safeSearch(djSearchArtists(effQ, 6), 20000),
        safeSearch(mrjSearchArtists(effQ, 6), 20000),
        safeSearch(saavnSearchArtists(effQ, 6), 20000),
      ]);
      const seen = new Set();
      artists = [...a, ...b, ...c, ...s].filter(ar => {
        const k = (ar.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 8);
    }
    // artist query? pull deeper from EVERY provider and rank the artist's songs first
    const qw = normName(effQ).split(' ').filter(w => w.length > 1);
    const artistHit = qw.length > 0 && artists.find(ar => {
      const n = normName(ar.name);
      return n && qw.every(w => n.includes(w));
    });
    const artistMode = !!artistHit;
    if (type === 'all' || type === 'songs') {
      const L = artistMode ? [18, 14, 14, 12] : [10, 8, 8, 8];
      const [a, b, c, s, y, yv, au] = await Promise.all([
        safeSearch(djpSearchSongs(effQ, L[0]), 25000),
        safeSearch(djSearchSongs(effQ, L[1]), 25000),
        safeSearch(mrjSearchSongs(effQ, L[2]), 25000),
        safeSearch(saavnSearchSongs(effQ, L[3]), 25000),
        safeSearch(ytSearchSongs(effQ, 10).catch(e => { tripSource('yt'); return []; }), 15000),
        // Real YouTube videos. Unlike the YouTube Music results above these
        // actually play: the client embeds the official player for them.
        safeSearch(ytVideoSearch(effQ, 12).catch(() => []), 15000),
        safeSearch(audiusSearchSongs(effQ, 6).catch(e => { tripSource('audius'); return []; }), 9000),
      ]);
      youtube = (y || []).slice(0, 10);
      ytVideos = (yv || []).slice(0, 12);
      songs = mergeTracks([interleave([a, b, c, s, au])]);
      if (artistMode) {
        const rank = t => { const n = normName(t.artist?.name); return qw.every(w => n.includes(w)) ? 0 : 1; };
        songs.sort((x, y) => rank(x) - rank(y));
      }
      // title-prefix boost is for title queries; on artist queries it
      // backfires — user uploads titled "ARTIST - TRACK" would outrank the
      // provider's clean catalogue (exposed when Audius joined the merge)
      if (!artistMode) {
        const fq = fold(effQ);
        const er = t => { const tt = fold(t.title || ''); return tt === fq ? 0 : (fq && tt.startsWith(fq) ? 1 : 2); };
        songs.sort((x, y) => er(x) - er(y));
      }
      songs = songs.slice(0, artistMode ? 40 : 20);
    }
    if (type === 'all' || type === 'albums') {
      const [a, b, c, s] = await Promise.all([
        safeSearch(djpSearchAlbums(effQ, 5), 20000),
        safeSearch(djSearchAlbums(effQ, 4), 20000),
        safeSearch(mrjSearchAlbums(effQ, 4), 20000),
        safeSearch(saavnSearchAlbums(effQ, 4), 20000),
      ]);
      albums = [...a, ...b, ...c, ...s].slice(0, 12);
    }
    if (effY || minD || maxD || langF || expF === 'clean') {
      songs = songs.filter(t => passFilters(t, { y: effY, minD, maxD, lang: langF, clean: expF === 'clean' }));
      if (effY) albums = albums.filter(a => passYear(a.year, effY));
    }
    for (const ar of artists) addSuggestArtist(ar.name, ar.image);
    let didYouMean = '';
    if (!nl.unsupported && !artistMode) {
      const weak = !songs.length || songs.slice(0, 3).every(t => overlapScore(titleTokens(effQ), titleTokens(t.title)) < 0.3);
      if (weak) didYouMean = await suggestCorrection(effQ).catch(() => '');
    }
    const payload = { songs, albums, artists, youtube, ytVideos, ...(artistMode ? { artist: { name: artistHit.name } } : {}), ...((nl.note || nl.mode || nl.year || nl.unsupported || nl.cleaned) ? { nl } : {}), ...(didYouMean ? { didYouMean } : {}) };
    setCache(req.originalUrl, payload);
    res.json(payload);
    // warm: resolve (API + decrypt) the top Saavn stream URLs in the background
    // so the first tap plays instantly instead of paying ~1.5s of latency
    try {
      const seen = new Set();
      let n = 0;
      for (const t of (payload.songs || [])) {
        if (n >= 2) break;
        const sid = t?.source === 'saavn' ? String(t.sourceId || '') : '';
        if (!sid || seen.has(sid) || saavnUrlCache.has(sid)) continue;
        seen.add(sid); n++;
        saavnStreamUrls(sid).catch(() => {});
      }
    } catch { /* noop */ }
  } catch (e) { res.status(502).json({ error: 'Search failed', detail: e.message }); }
});

app.get('/api/song/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  if (!['djp', 'dj', 'mrj', 'saavn'].includes(source)) return res.status(404).json({ error: 'Unknown source' });
  if (String(id || '').length > 300) return res.status(404).json({ error: 'Bad id' });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    let track = null;
    if (source === 'djp') {
      const e = (await djpLoadIndex()).get(String(id));
      if (!e || e.album) return res.status(404).json({ error: 'Song not indexed' });
      track = normalizeDjpSong(id, await djpSongPage(e.url));
    } else if (source === 'dj') {
      if (String(id).startsWith('t:')) {
        const c = djCustom.get(String(id)) || { title: 'Unknown Track', artist: 'Unknown', cover: '', duration: 0 };
        track = { id: `dj:${id}`, source: 'dj', sourceId: String(id), type: 'track', title: c.title, artist: { id: '', name: c.artist, image: c.cover || '' }, artists: [], album: { id: '', name: '', image: c.cover || '' }, duration: c.duration || 0, image: c.cover || '', streamUrl: `/api/audio?src=dj&id=${id}`, previewUrl: '', isPreview: false, codec: 'mp3', quality: '320', explicit: false, year: '', language: '', plays: 0 };
      } else {
        const e = (await djLoadIndex()).get(String(id).toLowerCase());
        if (!e || e.album) return res.status(404).json({ error: 'Song not indexed' });
        track = normalizeDjSong(e.id, await djSongPage(e.url));
      }
    } else if (source === 'mrj') {
      const e = (await mrjLoadIndex()).get(String(id));
      if (!e || e.album) return res.status(404).json({ error: 'Song not indexed' });
      track = normalizeMrjSong(id, await mrjSongPage(e.url));
    } else {
      track = await saavnSongDetail(id).catch(() => null);
      if (!track) return res.status(404).json({ error: 'Song not found' });
    }
    if (!track) return res.status(404).json({ error: 'Song unavailable' });
    setCache(req.originalUrl, track, 30 * 60 * 1000);
    res.json(track);
  } catch (e) { res.status(502).json({ error: 'Song failed', detail: e.message }); }
});

app.get('/api/album/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  if (!['djp', 'dj', 'mrj', 'saavn'].includes(source)) return res.status(404).json({ error: 'Unknown source' });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    let payload = null;
    if (source === 'djp') {
      const e = (await djpLoadIndex()).get(String(id));
      if (!e) return res.status(404).json({ error: 'Album not indexed' });
      const pg = await djpAlbumPage(e.url);
      const songs = (await Promise.all((pg.trackUrls || []).slice(0, 30).map(async u => {
        try {
          const tid = (u.match(/mp3-song-(\d+)\.html/) || [])[1];
          if (!tid) return null;
          return normalizeDjpSong(tid, await djpSongPage(u));
        } catch { return null; }
      }))).filter(Boolean);
      payload = {
        id: `djp:al:${id}`, source: 'djp', sourceId: String(id), type: 'album',
        name: pg.title || prettySlug(e.slug), artist: songs[0]?.artist?.name || '',
        image: pg.cover || songs[0]?.image || '', year: '', trackCount: songs.length, description: '', songs,
      };
    } else if (source === 'dj') {
      const e = (await djLoadIndex()).get('al:' + String(id).toLowerCase());
      if (!e) return res.status(404).json({ error: 'Album not indexed' });
      const pg = await djAlbumPage(e.url, true);
      const songs = (pg.tracks || []).slice(0, 30).map(tr => normalizeDjTrack({ ...tr, artist: tr.artist || pg.artist }, pg.cover));
      payload = {
        id: `dj:al:${id}`, source: 'dj', sourceId: String(id), type: 'album',
        name: pg.title || 'Unknown Album', artist: pg.artist || songs[0]?.artist?.name || '',
        image: pg.cover || songs[0]?.image || '', year: '', trackCount: songs.length, description: '', songs,
      };
    } else if (source === 'mrj') {
      const e = (await mrjLoadIndex()).get('al:' + String(id));
      if (!e) return res.status(404).json({ error: 'Album not indexed' });
      const pg = await mrjAlbumPage(e.url);
      let songs = [];
      if (pg.single) {
        const t = normalizeMrjSong(pg.singleId || id, pg);
        if (t) songs = [t];
      } else {
        const idx = await mrjLoadIndex();
        songs = (await Promise.all((pg.trackIds || []).slice(0, 30).map(async (tid) => {
          try {
            const se = idx.get(String(tid));
            if (!se) return null;
            return normalizeMrjSong(tid, await mrjSongPage(se.url));
          } catch { return null; }
        }))).filter(Boolean);
      }
      payload = {
        id: `mrj:al:${id}`, source: 'mrj', sourceId: String(id), type: 'album',
        name: pg.single ? (pg.title || prettySlug(e.slug)) : (pg.title || prettySlug(e.slug)),
        artist: pg.single ? (pg.artist || '') : (songs[0]?.artist?.name || ''),
        image: pg.cover || songs[0]?.image || '', year: '', trackCount: songs.length, description: '', songs,
      };
    } else {
      payload = await saavnAlbumDetail(id).catch(() => null);
      if (!payload) return res.status(404).json({ error: 'Album not found' });
    }
    setCache(req.originalUrl, payload, 30 * 60 * 1000);
    res.json(payload);
  } catch (e) { res.status(502).json({ error: 'Album failed', detail: e.message }); }
});

app.get('/api/artist/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  if (!['djp', 'dj', 'mrj', 'saavn'].includes(source)) return res.status(404).json({ error: 'Unknown source' });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const data = source === 'djp' ? await djpArtistDetail(id) : source === 'dj' ? await djArtistDetail(id) : source === 'mrj' ? await mrjArtistDetail(id) : await saavnArtistDetail(id);
    if (!data) return res.status(404).json({ error: 'Artist not found' });
    setCache(req.originalUrl, data, 15 * 60 * 1000);
    res.json(data);
  } catch (e) { res.status(502).json({ error: 'Artist failed', detail: e.message }); }
});

// ---------------- Lyrics: LRCLIB (synced) first, lyrics.ovh fallback ----------------
// Recipe ported from EchoMusicApp's LrcLib module: junk-phrase title cleanup,
// primary-artist extraction, 5 escalating search strategies, duration match
// (+-5s) preferring synced lines.
const LRC_JUNK_RE = /\s*\((official|video|audio|lyrics?|visualizer|hd|hq|4k|remaster|remix|live|acoustic|version|edit|extended|radio|clean|explicit)[^)]*\)|\s*\[[^\]]*(official|video|audio|lyrics?|visualizer|hd|hq|4k|remaster|remix|live|acoustic|version|edit|extended|radio|clean|explicit)[^\]]*\]|\s*\u3010.*?\u3011|\s*\|.*$|\s*-\s*(official|video|audio|lyrics?|visualizer).*$/gi;
const LRC_FEAT_RE = /\s*\((feat|ft)\..*?\)|\s*(feat|ft)\..*$/gi;
const lrcCleanTitle = (t) => String(t || '').replace(LRC_JUNK_RE, '').replace(LRC_FEAT_RE, '').trim();
function lrcPrimaryArtist(a) {
  let c = String(a || '').trim();
  for (const sep of [' & ', ' and ', ', ', ' x ', ' X ', ' feat. ', ' feat ', ' ft. ', ' ft ', ' featuring ', ' with ']) {
    const i = c.toLowerCase().indexOf(sep);
    if (i > 0) { c = c.slice(0, i); break; }
  }
  return c.trim();
}
async function lrcSearch(params) {
  const u = new URL('https://lrclib.net/api/search');
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'SoundWave/1.0 (lyrics; +https://soundwave-nh48.onrender.com)' } });
  if (!r.ok) return [];
  const j = await r.json().catch(() => []);
  return (Array.isArray(j) ? j : []).filter(t => t && (t.syncedLyrics || t.plainLyrics));
}
function lrcPick(tracks, duration) {
  if (!tracks.length) return null;
  if (!duration || duration <= 0) return tracks.find(t => t.syncedLyrics) || tracks[0];
  const close = (t) => Math.abs((+t.duration || 0) - duration) <= 5;
  return tracks.find(t => t.syncedLyrics && close(t)) || tracks.find(t => close(t)) || tracks.find(t => t.syncedLyrics) || tracks[0];
}
async function lrcLyrics(title, artist, album, duration) {
  const ct = lrcCleanTitle(title), ca = lrcPrimaryArtist(artist);
  const strategies = [
    { track_name: ct, artist_name: ca, album_name: (album || '').trim() },
    { track_name: ct },
    { q: `${ca} ${ct}`.trim() },
    { q: ct },
  ];
  if (ct !== String(title || '').trim() || ca !== String(artist || '').trim()) {
    strategies.push({ track_name: String(title || '').trim(), artist_name: String(artist || '').trim() });
  }
  for (const s of strategies) {
    const hits = await lrcSearch(s).catch(() => []);
    const best = lrcPick(hits, duration);
    if (best) return { text: best.syncedLyrics || best.plainLyrics, synced: !!best.syncedLyrics };
  }
  return null;
}
// KuGou lyrics (Echo's KuGou recipe): song search -> hash -> lyric search ->
// base64 LRC download. Strict duration + timed-line guards — KuGou fuzzy
// matching returns wrong-song junk otherwise.
async function kugouLyrics(title, artist, album, duration) {
  const clean = (s) => String(s || '').replace(/\(.*?\)|（.*?）|「.*?」|『.*?』|<.*?>|《.*?》|〈.*?〉|＜.*?＞/g, '').trim();
  const kw = `${clean(title)} - ${clean(artist)}${album ? ' ' + clean(album) : ''}`.trim();
  if (!clean(title) || !clean(artist)) return null;
  const songs = await (await fetch(`https://mobileservice.kugou.com/api/v3/search/song?version=9108&plat=0&pagesize=5&showtype=0&keyword=${encodeURIComponent(kw)}`, { signal: AbortSignal.timeout(8000) })).json().catch(() => null);
  for (const s of (songs?.data?.info || [])) {
    if (duration > 0 && Math.abs((+s.duration || 0) - duration) > 8) continue;
    if (!s.hash) continue;
    const L = await (await fetch(`https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&hash=${encodeURIComponent(s.hash)}`, { signal: AbortSignal.timeout(8000) })).json().catch(() => null);
    const cand = (L?.candidates || [])[0];
    if (!cand?.id || !cand?.accesskey) continue;
    const d = await (await fetch(`https://lyrics.kugou.com/download?fmt=lrc&charset=utf8&client=pc&ver=1&id=${cand.id}&accesskey=${encodeURIComponent(cand.accesskey)}`, { signal: AbortSignal.timeout(8000) })).json().catch(() => null);
    if (!d?.content) continue;
    const text = Buffer.from(d.content, 'base64').toString('utf8');
    if ((text.match(/\[\d{1,2}:\d{2}/g) || []).length >= 5) return { text, synced: true };
  }
  return null;
}
app.get('/api/lyrics', async (req, res) => {
  const artist = (req.query.artist || '').trim().slice(0, 200);
  const title = (req.query.title || '').trim().slice(0, 200);
  const album = (req.query.album || '').trim().slice(0, 200);
  const duration = Math.round(+req.query.duration || 0);
  if (!artist || !title) return res.json({ lyrics: null });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const hit = await lrcLyrics(title, artist, album, duration).catch(() => null);
    if (hit?.text) {
      const payload = { lyrics: hit.text, synced: hit.synced, source: 'lrclib' };
      setCache(req.originalUrl, payload, 3600000);
      return res.json(payload);
    }
    const kg = await kugouLyrics(title, artist, album, duration).catch(() => null);
    if (kg?.text) {
      const payload = { lyrics: kg.text, synced: kg.synced, source: 'kugou' };
      setCache(req.originalUrl, payload, 3600000);
      return res.json(payload);
    }
    const r = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(lrcPrimaryArtist(artist))}/${encodeURIComponent(lrcCleanTitle(title))}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    const payload = { lyrics: j.lyrics || null, synced: false, source: j.lyrics ? 'ovh' : null };
    setCache(req.originalUrl, payload, 3600000);
    res.json(payload);
  } catch { res.json({ lyrics: null }); }
});

// Legacy DJPunjab audio route (kept for older saved tracks) — download once, serve seekable
// Serve production client build from the same process
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../client/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, {
    maxAge: '1y',
    immutable: true,
    setHeaders: (res, file) => { if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDir, 'index.html'));
  });
  console.log('   Serving client build from ../client/dist');
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------- Listen Together parties (Echo-style rooms, HTTP polling) ----------------
// In-memory rooms: host beats state every ~5s, guests poll every ~3s.
// No persistence, no accounts — rooms evaporate 60s after the last beat.
const parties = new Map(); // code -> { track, position, isPlaying, updatedAt }
const PARTY_TTL = 60000, PARTY_MAX = 200;
const PARTY_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function partySweep() {
  const now = Date.now();
  for (const [c, r] of parties) if (now - r.updatedAt > PARTY_TTL) parties.delete(c);
  while (parties.size > PARTY_MAX) parties.delete(parties.keys().next().value);
}
app.post('/api/party', (req, res) => {
  partySweep();
  let code = '';
  do { code = Array.from({ length: 6 }, () => PARTY_CHARS[Math.floor(Math.random() * PARTY_CHARS.length)]).join(''); } while (parties.has(code));
  parties.set(code, { track: null, position: 0, isPlaying: false, updatedAt: Date.now() });
  res.json({ code });
});
app.post('/api/party/:code/beat', (req, res) => {
  partySweep();
  const room = parties.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.json({ ended: true }); // 200, not 404: dead polls must not spam console errors
  const t = req.body?.track;
  room.track = t && typeof t === 'object' && t.id ? t : room.track;
  room.position = Math.max(0, +req.body?.position || 0);
  room.isPlaying = !!req.body?.isPlaying;
  room.updatedAt = Date.now();
  res.json({ ok: true });
});
app.get('/api/party/:code', (req, res) => {
  partySweep();
  const room = parties.get(String(req.params.code || '').toUpperCase());
  if (!room) return res.json({ ended: true }); // 200, not 404: dead polls must not spam console errors
  res.json(room);
});
app.post('/api/party/:code/end', (req, res) => {
  parties.delete(String(req.params.code || '').toUpperCase());
  res.json({ ok: true });
});
// Exported so integration tests can close the socket and exit cleanly. Importing
// this module starts the server — it is the process entry point.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 SoundWave server on http://localhost:${PORT} (djp + djjohal + mr-jatt)`);
  djpLoadIndex().then(m => console.log(`   DJPunjab index: ${m.size}`)).catch(() => {});
  djLoadIndex().then(m => console.log(`   DJJohal index: ${m.size}`)).catch(() => {});
  mrjLoadIndex().then(m => console.log(`   Mr-Jatt index: ${m.size}`)).catch(() => {});
});

export default server;
