// SoundWave server — DJPunjab-only backend.
// One source, done well: sitemap + fresh-charts index, exact MP3s, seekable cached audio.
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

// ---------------- DJPunjab ----------------
const DJP_BASE = (process.env.DJP_BASE_URL || 'https://djpunjab.is').replace(/\/$/, '');
const DJP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const INDEX_TTL = 6 * 3600 * 1000;   // re-crawl sitemap + fresh charts every 6h
const PAGE_TTL = 6 * 3600 * 1000;    // song/album page cache
const AUDIO_TTL = 60 * 60 * 1000;    // downloaded MP3 cache
const AUDIO_MAX = 10;                // LRU entries (~70MB @320k)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** GET text with retries (reliability first). */
async function fetchText(url, { timeout = 20000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': DJP_UA, Referer: `${DJP_BASE}/`, Accept: 'text/html,*/*' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { lastErr = e; await sleep(400 * (attempt + 1)); }
    finally { clearTimeout(to); }
  }
  throw lastErr;
}

/** GET binary (MP3) — single attempt, caller handles fallback chain. */
async function fetchBuf(url, timeout = 90000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': DJP_UA, Referer: `${DJP_BASE}/` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } finally { clearTimeout(to); }
}

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
        const xml = await fetchText(`${DJP_BASE}/sitemap.xml`, { timeout: 30000 });
        for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
          const p = parseDjpLoc(m[1]);
          if (p) map.set(p.id, p);
        }
      } catch (e) { console.error('djp sitemap failed:', e.message); }
      // Sitemap is stale (misses newest uploads) — merge the fresh-songs chart.
      const fresh = [];
      try {
        const html = await fetchText(`${DJP_BASE}/page/latest.html`, { timeout: 20000 });
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
djpLoadIndex().then(m => console.log(`   DJPunjab index: ${m.size} entries`)).catch(() => {});

function djpScore(slug, words) {
  const s = ` ${slug.replace(/-/g, ' ')} `;
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

const djpPageCache = new Map(); // url -> { data, time }
function pageCacheGet(url) {
  const hit = djpPageCache.get(url);
  if (hit && Date.now() - hit.time < PAGE_TTL) return hit.data;
  return null;
}
function pageCacheSet(url, data) {
  if (djpPageCache.size > 400) djpPageCache.delete(djpPageCache.keys().next().value);
  djpPageCache.set(url, { data, time: Date.now() });
}

async function djpSongPage(url) {
  const hit = pageCacheGet(url);
  if (hit) return hit;
  const html = await fetchText(url);
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
  // duration ≈ bytes ÷ bitrate (CBR MP3s — accurate; non-fatal if HEAD fails)
  let duration = 0;
  const best = mp3s['320'] || mp3s['128'] || mp3s['48'] || '';
  const br = mp3s['320'] ? 320 : mp3s['128'] ? 128 : 48;
  if (best) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      try {
        const h = await fetch(best, { method: 'HEAD', signal: ctrl.signal, headers: { 'User-Agent': DJP_UA, Referer: `${DJP_BASE}/` } });
        const len = parseInt(h.headers.get('content-length') || '0', 10);
        if (len > 100000) duration = Math.round((len * 8) / (br * 1000));
      } finally { clearTimeout(to); }
    } catch { /* leave 0 — client fills from audio element */ }
  }
  const data = { mp3: best, mp3s, quality: mp3s['320'] ? '320' : mp3s['128'] ? '128' : '48', title, artist: artist || 'Unknown', cover, duration };
  pageCacheSet(url, data);
  return data;
}

async function djpAlbumPage(url) {
  const hit = pageCacheGet(url);
  if (hit) return hit;
  const html = await fetchText(url);
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
  const words = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return [];
  const songHits = [], albumHits = [];
  for (const [id, e] of idx) {
    const s = djpScore(e.slug, words);
    if (s <= 0) continue;
    (e.album ? albumHits : songHits).push([s, id, e]);
  }
  songHits.sort((a, b) => b[0] - a[0]);
  albumHits.sort((a, b) => b[0] - a[0]);
  // direct song pages first
  const pages = await Promise.all(songHits.slice(0, limit).map(([, id, e]) => djpSongPage(e.url).then(pg => ({ id, pg })).catch(() => null)));
  const out = pages.filter(Boolean).map(({ id, pg }) => normalizeDjpSong(id, pg)).filter(Boolean);
  // fill the rest from matched albums' tracks (most DJP "albums" are singles)
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
  const words = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
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
    // fallback: highest song ids first (ids grow over time)
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
    const html = await fetchText(`${DJP_BASE}/punjabi_music/latest.php`, { timeout: 20000 });
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
    const html = await fetchText(`${DJP_BASE}/artist/${slug}-top-songs`, { timeout: 15000 });
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
  // albums by this artist (cheap: metadata only, no track resolution)
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

// ---------------- API ----------------
app.get('/api/health', (req, res) => res.json({ ok: true, source: 'djpunjab', time: new Date().toISOString() }));

app.get('/api/sources', async (req, res) => {
  try {
    const m = await djpLoadIndex();
    res.json({ djpunjab: m.size > 100 ? 'ok' : 'empty', indexSize: m.size, latest: djpLatestIds.length, uptime: Math.round(process.uptime()) });
  } catch (e) { res.json({ djpunjab: `down: ${e.message}`, indexSize: 0 }); }
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const type = (req.query.type || 'all').toLowerCase();
  if (!q) return res.json({ songs: [], albums: [], artists: [] });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const [songs, albums, artists] = await Promise.all([
      (type === 'all' || type === 'songs') ? djpSearchSongs(q, 15).catch(() => []) : [],
      (type === 'all' || type === 'albums') ? djpSearchAlbums(q, 8).catch(() => []) : [],
      (type === 'all' || type === 'artists') ? djpSearchArtists(q, 8).catch(() => []) : [],
    ]);
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
  if (source !== 'djp') return res.status(404).json({ error: 'Unknown source' });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const e = (await djpLoadIndex()).get(String(id));
    if (!e || e.album) return res.status(404).json({ error: 'Song not indexed' });
    const track = normalizeDjpSong(id, await djpSongPage(e.url));
    if (!track) return res.status(404).json({ error: 'Song unavailable' });
    setCache(req.originalUrl, track, 30 * 60 * 1000);
    res.json(track);
  } catch (e) { res.status(502).json({ error: 'Song failed', detail: e.message }); }
});

app.get('/api/album/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  if (source !== 'djp') return res.status(404).json({ error: 'Unknown source' });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
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
    const payload = {
      id: `djp:al:${id}`, source: 'djp', sourceId: String(id), type: 'album',
      name: pg.title || prettySlug(e.slug), artist: songs[0]?.artist?.name || '',
      image: pg.cover || songs[0]?.image || '', year: '', trackCount: songs.length, description: '', songs,
    };
    setCache(req.originalUrl, payload, 30 * 60 * 1000);
    res.json(payload);
  } catch (e) { res.status(502).json({ error: 'Album failed', detail: e.message }); }
});

app.get('/api/artist/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  if (source !== 'djp') return res.status(404).json({ error: 'Unknown source' });
  const cached = getCache(req.originalUrl);
  if (cached) return res.json(cached);
  try {
    const data = await djpArtistDetail(id);
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

// DJPunjab audio: download full MP3 once, keep in memory, serve seekable.
// Quality falls back down the chain (320→128→48) so playback ~never fails.
const QUALITY_ORDER = { high: ['320', '128', '48'], medium: ['128', '320', '48'], low: ['48', '128', '320'] };
const djpAudioCache = new Map(); // key -> { buf, time }
function serveBuf(res, req, buf, cached, br) {
  res.setHeader('Content-Type', 'audio/mpeg');
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
        const buf = await fetchBuf(url).catch(() => null);
        if (buf && buf.length > 100000) return { buf, br };
      }
      return null;
    };
    let got = await attempt(await djpSongPage(e.url));
    if (!got) {
      djpPageCache.delete(e.url); // page may be stale — refresh once and retry
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
  console.log(`🎵 SoundWave server on http://localhost:${PORT} (DJPunjab-only)`);
});
