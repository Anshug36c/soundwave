// SoundWave server — Punjabi multi-source backend (DJPunjab + DJJohal + Mr-Jatt/PenduJatt)
// with fastest-mirror audio + instant Tidal FLAC previews.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 5000;
app.use(express.json());

// ---------------- tiny TTL cache ----------------
const cache = new Map(); // key -> { v, t, ttl }
function getCache(key) {
  const h = cache.get(key);
  if (!h) return null;
  if (Date.now() - h.t > h.ttl) { cache.delete(key); return null; }
  return h.v;
}
function setCache(key, val, ttl = 5 * 60 * 1000) {
  if (cache.size > 500) cache.clear();
  cache.set(key, { v: val, t: Date.now(), ttl });
}

// ---------------- shared fetch ----------------
const DJP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** GET text with retries (reliability first). */
async function fetchText(url, { timeout = 20000, referer = null } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': DJP_UA, ...(referer ? { Referer: referer } : {}), Accept: 'text/html,*/*' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { lastErr = e; await sleep(400 * (attempt + 1)); }
    finally { clearTimeout(to); }
  }
  throw lastErr;
}

/** GET binary (MP3) — single attempt, caller handles fallback chain. */
async function fetchBuf(url, timeout = 90000, referer = null) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': DJP_UA, ...(referer ? { Referer: referer } : {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } finally { clearTimeout(to); }
}

const INDEX_TTL = 6 * 3600 * 1000;
const PAGE_TTL = 6 * 3600 * 1000;
const AUDIO_TTL = 60 * 60 * 1000;
const AUDIO_MAX = 10;

function djpScore(slug, words) {
  const s = ` ${String(slug || '').toLowerCase().replace(/-/g, ' ')} `;
  let score = 0;
  for (const w of words) {
    if (s.includes(` ${w} `)) score += 3;
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
function queryWords(q) {
  return String(q || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
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

/** Track duration via 1-byte Range probe (bytes ÷ bitrate). Non-fatal. */
async function headDuration(url, kbps) {
  if (!url || !kbps) return 0;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    try {
      const h = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': DJP_UA, Range: 'bytes=0-0' } });
      const cr = h.headers.get('content-range') || '';
      const len = parseInt(cr.split('/')[1] || h.headers.get('content-length') || '0', 10);
      if (len > 100000) return Math.round((len * 8) / (kbps * 1000));
    } finally { clearTimeout(to); }
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
    streamUrl: `/api/djp-audio?id=${id}`, previewUrl: '', isPreview: false,
    codec: 'mp3', quality: pg.quality, explicit: false,
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

async function djpLatestSongs(n = 12) {
  const idx = await djpLoadIndex().catch(() => new Map());
  let ids = [...djpLatestIds];
  if (!ids.length && idx.size) {
    ids = [...idx.entries()].filter(([, e]) => !e.album).map(([id]) => id)
      .sort((a, b) => Number(b) - Number(a)).slice(0, n * 2);
  }
  const out = [];
  for (const id of ids.slice(0, n * 2)) {
    if (out.length >= n) break;
    try {
      const e = idx.get(String(id));
      const t = e ? normalizeDjpSong(id, await djpSongPage(e.url)) : null;
      if (t) out.push(t);
    } catch { /* skip duds */ }
  }
  return out;
}

async function djpLatestAlbums(n = 8) {
  let links = [];
  try {
    const html = await fetchText(`${DJP_BASE}/punjabi_music/latest.php`, { timeout: 20000, referer: `${DJP_BASE}/` });
    for (const m of html.matchAll(/href="([^"]*?-album-\d+\.html)"/gi)) {
      const u = (m[1].startsWith('http') ? m[1] : DJP_BASE + m[1]).replace(/&amp;/g, '&');
      const p = parseDjpLoc(u);
      if (p) links.push(p);
    }
  } catch (e) { console.error('djp latest albums failed:', e.message); }
  if (!links.length) {
    const idx = await djpLoadIndex().catch(() => new Map());
    links = [...idx.values()].filter(e => e.album).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, n * 2);
  }
  const pages = await Promise.all(links.slice(0, n * 2).map(p => djpAlbumPage(p.url).then(pg => ({ p, pg })).catch(() => null)));
  return pages.filter(Boolean).slice(0, n).map(({ p, pg }) => ({
    id: `djp:al:${p.id}`, source: 'djp', sourceId: String(p.id), type: 'album',
    name: pg.title || prettySlug(p.slug), artist: '', image: pg.cover || '', year: '',
    trackCount: (pg.trackUrls || []).length,
  }));
}

const TRENDING_QUERIES = ['ap dhillon', 'diljit dosanjh', 'guru randhawa', 'jasmine sandlas', 'tulsi kumar', 'prem dhillon'];
async function djpTrending(per = 2) {
  const parts = await Promise.all(TRENDING_QUERIES.map(q => djpSearchSongs(q, per).catch(() => [])));
  return parts.flat().slice(0, 12);
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
    codec: 'mp3', quality, explicit: false,
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
    codec: 'mp3', quality: '320', explicit: false,
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
    codec: 'mp3', quality: pg.quality || '320', explicit: false,
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

// ---------------- cross-source merge (dedupes same song, keeps mirrors) ----------------
function normKey(title, artist) {
  return `${title || ''}|${artist || ''}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
}
function buildAudioUrl(mirrors) {
  const [p, ...rest] = mirrors;
  return `/api/audio?src=${p.source}&id=${encodeURIComponent(p.sourceId)}` + rest.map(m => `&m=${m.source}:${encodeURIComponent(m.sourceId)}`).join('');
}
function mergeTracks(lists) {
  const seen = new Map();
  const out = [];
  for (const list of lists) {
    for (const t of list || []) {
      if (!t) continue;
      const k = normKey(t.title, t.artist?.name);
      if (seen.has(k)) {
        const m = seen.get(k);
        if (m.mirrors.length < 4 && !m.mirrors.some(x => x.source === t.source && x.sourceId === t.sourceId)) {
          m.mirrors.push({ source: t.source, sourceId: t.sourceId });
        }
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

// ---------------- fastest-mirror audio ----------------
const QUALITY_ORDER = { high: ['320', '128', '48'], medium: ['128', '320', '48'], low: ['48', '128', '320'] };
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

async function resolveMirror(source, sid) {
  try {
    if (source === 'djp') {
      const e = (await djpLoadIndex()).get(String(sid));
      if (!e || e.album) return null;
      const pg = await djpSongPage(e.url);
      return pg.mp3s && Object.keys(pg.mp3s).length ? { mp3s: pg.mp3s } : null;
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
      const pg = await djSongPage(e.url);
      return pg.mp3s && Object.keys(pg.mp3s).length ? { mp3s: pg.mp3s } : null;
    }
    if (source === 'mrj') {
      const e = (await mrjLoadIndex()).get(String(sid));
      if (!e || e.album) return null;
      const pg = await mrjSongPage(e.url);
      return pg.mp3s && Object.keys(pg.mp3s).length ? { mp3s: pg.mp3s } : null;
    }
  } catch { /* unresolvable mirror */ }
  return null;
}

const audioCache = new Map(); // key -> { buf, br, time }
function serveBuf(res, req, buf, cached, br, type = 'audio/mpeg') {
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Audio-Cache', cached ? 'HIT' : 'MISS');
  if (br) res.setHeader('X-Audio-Bitrate', br);
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
}

app.get('/api/audio', async (req, res) => {
  const src = req.query.src, sid = req.query.id;
  const q = QUALITY_ORDER[req.query.quality] ? req.query.quality : 'high';
  if (!src || !sid) return res.status(400).json({ error: 'Missing src/id' });
  const ms = [req.query.m || []].flat().map(s => {
    const i = String(s).indexOf(':');
    return i > 0 ? { source: s.slice(0, i), sid: s.slice(i + 1) } : null;
  }).filter(Boolean);
  const mirrors = [{ source: src, sid: String(sid) }, ...ms].slice(0, 4);
  const key = `${src}:${sid}:${q}`;
  const hit = audioCache.get(key);
  if (hit && Date.now() - hit.time < AUDIO_TTL) return serveBuf(res, req, hit.buf, true, hit.br);
  try {
    const resolved = (await Promise.all(mirrors.map(async m => ({ ...m, r: await resolveMirror(m.source, m.sid) })))).filter(x => x.r);
    if (!resolved.length) return res.status(502).json({ error: 'No working mirror' });
    const order = QUALITY_ORDER[q];
    const hostOf = (m) => {
      for (const br of order) {
        const u = m.r.mp3s[br];
        if (u) { try { return new URL(u).host; } catch { return ''; } }
      }
      return '';
    };
    resolved.sort((a, b) => cdnScore(hostOf(a)) - cdnScore(hostOf(b)));
    const wantRange = !!req.headers.range;
    for (const br of order) {
      for (const m of resolved) {
        const urls = [m.r.mp3s[br] || []].flat().filter(Boolean);
        for (const url of urls) {
        const t0 = Date.now();
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 90000);
          const up = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': DJP_UA, ...(refererFor(url) ? { Referer: refererFor(url) } : {}), ...(wantRange ? { Range: req.headers.range } : {}) },
          });
          if (up.status !== 200 && up.status !== 206) { clearTimeout(to); continue; }
          if (wantRange && up.status !== 206) { clearTimeout(to); continue; } // range-ignoring mirror: skip
          noteCdn(new URL(url).host, Date.now() - t0);
          res.status(up.status);
          res.setHeader('Content-Type', 'audio/mpeg');
          const len = up.headers.get('content-length');
          if (len) res.setHeader('Content-Length', len);
          const cr = up.headers.get('content-range');
          if (cr) res.setHeader('Content-Range', cr);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.setHeader('X-Audio-Cache', 'MISS');
          res.setHeader('X-Audio-Bitrate', br);
          res.setHeader('X-Audio-Mirror', m.source);
          const reader = up.body.getReader();
          const chunks = up.status === 200 ? [] : null;
          let received = 0, aborted = false;
          req.on('close', () => { aborted = true; clearTimeout(to); try { reader.cancel(); } catch {} });
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (chunks) chunks.push(value);
            if (!res.write(value)) await new Promise(r => res.once('drain', r));
          }
          clearTimeout(to);
          res.end();
          const expected = len ? parseInt(len, 10) : 0;
          if (chunks && !aborted && received > 100000 && (!expected || received === expected)) {
            if (audioCache.size >= AUDIO_MAX) audioCache.delete(audioCache.keys().next().value);
            audioCache.set(key, { buf: Buffer.concat(chunks), br, time: Date.now() });
          }
          return;
        } catch { /* next candidate */ }
        }
      }
    }
    if (!res.headersSent) res.status(502).json({ error: 'All mirrors failed' });
  } catch (e) { if (!res.headersSent) res.status(502).json({ error: 'Audio failed', detail: e.message }); }
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
  if (hit && Date.now() - hit.time < 30 * 60 * 1000) return serveBuf(res, req, hit.buf, true, 'FLAC', 'audio/mp4');
  const neg = tidalPreviewNeg.get(key);
  if (neg && Date.now() - neg < 3600000) return res.status(404).json({ error: 'No preview match' });
  try {
    const j = await tidalFetch(`/v1/search/tracks?query=${encodeURIComponent(`${title} ${artist}`.trim())}&limit=5`, 15000);
    const items = j?.items || [];
    let best = null, bestS = 0;
    for (const t of items) {
      const s = tpScore(title, artist, t.title || '', (t.artists || []).map(a => a.name).join(' '));
      if (s > bestS) { bestS = s; best = t; }
    }
    if (!best || bestS < 0.45) {
      if (tidalPreviewNeg.size > 500) tidalPreviewNeg.clear();
      tidalPreviewNeg.set(key, Date.now());
      return res.status(404).json({ error: 'No preview match' });
    }
    const buf = await tidalStitchedAudio(best.id);
    if (tidalPreviewCache.size >= 12) tidalPreviewCache.delete(tidalPreviewCache.keys().next().value);
    tidalPreviewCache.set(key, { buf, time: Date.now() });
    serveBuf(res, req, buf, false, 'FLAC', 'audio/mp4');
  } catch (e) { if (!res.headersSent) res.status(502).json({ error: 'Preview failed', detail: e.message }); }
});

// ---------------- API ----------------
app.get('/api/health', (req, res) => res.json({ ok: true, sources: ['djpunjab', 'djjohal', 'mr-jatt', 'pendujatt'], time: new Date().toISOString() }));

app.get('/api/sources', async (req, res) => {
  const out = {};
  try { const m = await djpLoadIndex(); out.djpunjab = m.size > 100 ? 'ok' : 'empty'; out.djpunjab_index = m.size; }
  catch (e) { out.djpunjab = `down: ${e.message}`; }
  try { const m = await djLoadIndex(); out.djjohal = m.size > 1000 ? 'ok' : 'empty'; out.djjohal_index = m.size; }
  catch (e) { out.djjohal = `down: ${e.message}`; }
  try { const m = await mrjLoadIndex(); out.mrjatt = m.size > 1000 ? 'ok' : 'empty'; out.mrjatt_index = m.size; }
  catch (e) { out.mrjatt = `down: ${e.message}`; }
  out.pendujatt = 'mirror';
  try { await tidalToken(); out.tidal = 'ok'; } catch (e) { out.tidal = `down: ${e.message}`; }
  out.cdn = Object.fromEntries([...cdnMs.entries()].map(([h, ms]) => [h, Math.round(ms)]));
  out.uptime = Math.round(process.uptime());
  res.json(out);
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const type = (req.query.type || 'all').toLowerCase();
  if (!q) return res.json({ songs: [], albums: [], artists: [] });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    let songs = [], albums = [], artists = [];
    if (type === 'all' || type === 'songs') {
      const [a, b, c] = await Promise.all([
        djpSearchSongs(q, 10).catch(() => []),
        djSearchSongs(q, 8).catch(() => []),
        mrjSearchSongs(q, 8).catch(() => []),
      ]);
      songs = mergeTracks([a, b, c]).slice(0, 20);
    }
    if (type === 'all' || type === 'albums') {
      const [a, b, c] = await Promise.all([
        djpSearchAlbums(q, 5).catch(() => []),
        djSearchAlbums(q, 4).catch(() => []),
        mrjSearchAlbums(q, 4).catch(() => []),
      ]);
      albums = [...a, ...b, ...c].slice(0, 12);
    }
    if (type === 'all' || type === 'artists') {
      const [a, b, c] = await Promise.all([
        djpSearchArtists(q, 6).catch(() => []),
        djSearchArtists(q, 6).catch(() => []),
        mrjSearchArtists(q, 6).catch(() => []),
      ]);
      const seen = new Set();
      artists = [...a, ...b, ...c].filter(ar => {
        const k = (ar.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 8);
    }
    const payload = { songs, albums, artists };
    setCache(req.originalUrl, payload);
    res.json(payload);
  } catch (e) { res.status(502).json({ error: 'Search failed', detail: e.message }); }
});

app.get('/api/home', async (req, res) => {
  const cached = getCache('home:v1');
  if (cached) return res.json(cached);
  try {
    const [latest, trending, newReleases] = await Promise.all([
      djpLatestSongs(12).catch(() => []),
      djpTrending(2).catch(() => []),
      djpLatestAlbums(8).catch(() => []),
    ]);
    const hero = latest.filter(t => t.image).slice(0, 5);
    const seen = new Map();
    for (const t of [...trending, ...latest]) {
      const n = t.artist?.name || '';
      if (!n || n === 'Unknown') continue;
      const slug = slugifyName(n);
      if (!slug || seen.has(slug)) continue;
      seen.set(slug, { id: `djp:ar:${slug}`, source: 'djp', type: 'artist', name: n, image: t.image || '' });
    }
    const [party, romantic] = await Promise.all([
      djpSearchSongs('jasmine sandlas guru randhawa', 6).catch(() => []),
      djpSearchSongs('tulsi kumar', 6).catch(() => []),
    ]);
    const payload = {
      hero, newDrops: latest, trendingNow: trending.slice(0, 10),
      topArtists: [...seen.values()].slice(0, 10), newReleases,
      party: party.length ? party : trending.slice(0, 5),
      romantic: romantic.length ? romantic : latest.slice(0, 5),
    };
    setCache('home:v1', payload, 10 * 60 * 1000);
    res.json(payload);
  } catch (e) { res.status(502).json({ error: 'Home feed failed', detail: e.message }); }
});

app.get('/api/song/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  if (!['djp', 'dj', 'mrj'].includes(source)) return res.status(404).json({ error: 'Unknown source' });
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
        track = { id: `dj:${id}`, source: 'dj', sourceId: String(id), type: 'track', title: c.title, artist: { id: '', name: c.artist, image: c.cover || '' }, artists: [], album: { id: '', name: '', image: c.cover || '' }, duration: c.duration || 0, image: c.cover || '', streamUrl: `/api/audio?src=dj&id=${id}`, previewUrl: '', isPreview: false, codec: 'mp3', quality: '320', explicit: false };
      } else {
        const e = (await djLoadIndex()).get(String(id).toLowerCase());
        if (!e || e.album) return res.status(404).json({ error: 'Song not indexed' });
        track = normalizeDjSong(e.id, await djSongPage(e.url));
      }
    } else {
      const e = (await mrjLoadIndex()).get(String(id));
      if (!e || e.album) return res.status(404).json({ error: 'Song not indexed' });
      track = normalizeMrjSong(id, await mrjSongPage(e.url));
    }
    if (!track) return res.status(404).json({ error: 'Song unavailable' });
    setCache(req.originalUrl, track, 30 * 60 * 1000);
    res.json(track);
  } catch (e) { res.status(502).json({ error: 'Song failed', detail: e.message }); }
});

app.get('/api/album/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  if (!['djp', 'dj', 'mrj'].includes(source)) return res.status(404).json({ error: 'Unknown source' });
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
    } else {
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
    }
    setCache(req.originalUrl, payload, 30 * 60 * 1000);
    res.json(payload);
  } catch (e) { res.status(502).json({ error: 'Album failed', detail: e.message }); }
});

app.get('/api/artist/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  if (!['djp', 'dj', 'mrj'].includes(source)) return res.status(404).json({ error: 'Unknown source' });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const data = source === 'djp' ? await djpArtistDetail(id) : source === 'dj' ? await djArtistDetail(id) : await mrjArtistDetail(id);
    if (!data) return res.status(404).json({ error: 'Artist not found' });
    setCache(req.originalUrl, data, 15 * 60 * 1000);
    res.json(data);
  } catch (e) { res.status(502).json({ error: 'Artist failed', detail: e.message }); }
});

app.get('/api/lyrics', async (req, res) => {
  const artist = (req.query.artist || '').trim();
  const title = (req.query.title || '').trim();
  if (!artist || !title) return res.json({ lyrics: null });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const r = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    const payload = { lyrics: j.lyrics || null };
    setCache(req.originalUrl, payload, 3600000);
    res.json(payload);
  } catch { res.json({ lyrics: null }); }
});

// Legacy DJPunjab audio route (kept for older saved tracks) — download once, serve seekable
const djpAudioCache = new Map();
app.get('/api/djp-audio', async (req, res) => {
  const id = String(req.query.id || '');
  const q = QUALITY_ORDER[req.query.quality] ? req.query.quality : 'high';
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const key = `${id}:${q}`;
  const hit = djpAudioCache.get(key);
  if (hit && Date.now() - hit.time < AUDIO_TTL) return serveBuf(res, req, hit.buf, true, hit.br);
  try {
    const e = (await djpLoadIndex()).get(id);
    if (!e || e.album) return res.status(404).json({ error: 'Song not indexed' });
    const order = QUALITY_ORDER[q];
    const attempt = async (pg) => {
      for (const br of order) {
        const url = pg.mp3s?.[br];
        if (!url) continue;
        const buf = await fetchBuf(url, 90000, `${DJP_BASE}/`).catch(() => null);
        if (buf && buf.length > 100000) return { buf, br };
      }
      return null;
    };
    let got = await attempt(await djpSongPage(e.url));
    if (!got) {
      djpPageCache.delete(e.url);
      const pg2 = await djpSongPage(e.url).catch(() => null);
      if (pg2) got = await attempt(pg2);
    }
    if (!got) return res.status(502).json({ error: 'MP3 download failed' });
    if (djpAudioCache.size >= AUDIO_MAX) djpAudioCache.delete(djpAudioCache.keys().next().value);
    djpAudioCache.set(key, { buf: got.buf, br: got.br, time: Date.now() });
    serveBuf(res, req, got.buf, false, got.br);
  } catch (e) { if (!res.headersSent) res.status(502).json({ error: 'DJPunjab audio failed', detail: e.message }); }
});

// Serve production client build from the same process
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
  console.log(`🎵 SoundWave server on http://localhost:${PORT} (djp + djjohal + mr-jatt)`);
  djpLoadIndex().then(m => console.log(`   DJPunjab index: ${m.size}`)).catch(() => {});
  djLoadIndex().then(m => console.log(`   DJJohal index: ${m.size}`)).catch(() => {});
  mrjLoadIndex().then(m => console.log(`   Mr-Jatt index: ${m.size}`)).catch(() => {});
});
