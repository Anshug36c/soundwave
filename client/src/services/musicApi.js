// SoundWave API client — DJPunjab-only backend.
const BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

// request diagnostics, privacy-safe: endpoint paths only, never query strings.
// Survives reloads via sessionStorage so a bug report can include pre-reload history.
const DIAG_KEY = 'soundwave-diag-v1';
function diagLoad() {
  try {
    const j = JSON.parse(sessionStorage.getItem(DIAG_KEY) || 'null');
    if (j && Array.isArray(j.reqs)) return { reqs: j.reqs.slice(-60), fails: j.fails | 0, stalls: j.stalls | 0, skips: j.skips | 0, events: Array.isArray(j.events) ? j.events.slice(-20) : [] };
  } catch { /* noop */ }
  return null;
}
export const diag = {
  reqs: [],   // last 60: { p, ms, ok }
  fails: 0,   // non-abort failures
  stalls: 0,  // stall-watchdog trips
  skips: 0,   // tracks skipped after repeated stall recoveries
  events: [], // last 20 { e, ms } — playback transitions etc.
  reset() {
    this.reqs = []; this.fails = 0; this.stalls = 0; this.skips = 0; this.events = [];
    try { sessionStorage.removeItem(DIAG_KEY); } catch { /* noop */ }
  },
  ...(diagLoad() || {}),
};
function diagSave() {
  try { sessionStorage.setItem(DIAG_KEY, JSON.stringify({ reqs: diag.reqs, fails: diag.fails, stalls: diag.stalls, skips: diag.skips, events: diag.events })); } catch { /* noop */ }
}
function diagRecord(path, ms, ok) {
  try {
    diag.reqs.push({ p: String(path).split('?')[0], ms: Math.round(ms), ok: !!ok });
    if (diag.reqs.length > 60) diag.reqs.splice(0, diag.reqs.length - 60);
    if (!ok) diag.fails++;
    diagSave();
  } catch { /* noop */ }
}
export function diagEvent(name, ms) {
  try {
    diag.events.push({ e: String(name), ms: Math.round(ms) });
    if (diag.events.length > 20) diag.events.splice(0, diag.events.length - 20);
    diagSave();
  } catch { /* noop */ }
}
// engine bumps stalls/skips directly — persist those too
for (const k of ['stalls', 'skips']) {
  let v = diag[k];
  Object.defineProperty(diag, k, { get: () => v, set: (n) => { v = n; diagSave(); }, enumerable: true, configurable: true });
}

// identical concurrent GETs (StrictMode double-mount, two components, one URL)
// share a single network request; signal-carrying calls always run solo
const inflight = new Map();
async function get(path, { signal = null, timeout = 60000 } = {}) {
  if (!signal) {
    const pending = inflight.get(path);
    if (pending) return pending;
    const p = getInner(path, null, timeout);
    inflight.set(path, p);
    try { return await p; } finally { if (inflight.get(path) === p) inflight.delete(path); }
  }
  return getInner(path, signal, timeout);
}

// fetch with a hard client-side timeout so loaders can never hang forever.
// Pass { signal } to let callers cancel stale requests (fast typing).
async function getInner(path, signal, timeout) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(new Error('Request timed out')), timeout);
  const onAbort = () => ctrl.abort(signal.reason);
  try { signal?.addEventListener?.('abort', onAbort, { once: true }); } catch { /* noop */ }
  try {
    const r = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const e = new Error(body.error || `Request failed: ${r.status}`);
      e.status = r.status;
      throw e;
    }
    const j = await r.json();
    diagRecord(path, performance.now() - t0, true);
    return j;
  } catch (e) {
    const aborted = (() => { try { return signal?.aborted || ctrl.signal.aborted; } catch { return false; } })();
    diagRecord(path, performance.now() - t0, aborted); // cancels aren't failures
    throw e;
  } finally {
    clearTimeout(to);
    try { signal?.removeEventListener?.('abort', onAbort); } catch { /* noop */ }
  }
}

// POST helper (auth) — same timeout + diagnostics as GET, never deduped
async function post(path, body, { timeout = 30000 } = {}) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(new Error('Request timed out')), timeout);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const e = new Error(j.error || `Request failed: ${r.status}`);
      e.status = r.status;
      diagRecord(path, performance.now() - t0, false);
      throw e;
    }
    const j = await r.json();
    diagRecord(path, performance.now() - t0, true);
    return j;
  } catch (e) {
    if (e.status == null) diagRecord(path, performance.now() - t0, !!ctrl.signal.aborted);
    throw e;
  } finally {
    clearTimeout(to);
  }
}

const warmedUrls = new Map(); // warm-url -> last-fired time (client dedup)

export const api = {
  health: () => get('/health'),
  search: (q, type = 'all', f = {}, opts = {}) => {
    const p = new URLSearchParams({ q, type });
    if (f.y) p.set('y', f.y);
    if (f.minD) p.set('minD', f.minD);
    if (f.maxD) p.set('maxD', f.maxD);
    if (f.lang) p.set('lang', f.lang);
    if (f.exp) p.set('exp', f.exp);
    return get(`/search?${p.toString()}`, opts);
  },
  suggest: (q, limit = 8, opts = {}) => get(`/suggest?q=${encodeURIComponent(q)}&limit=${limit}`, { timeout: 15000, ...opts }),
  forYou: (mix, seeds, artists, limit = 15) => get(`/for-you?mix=${mix}&limit=${limit}&seeds=${encodeURIComponent(JSON.stringify(seeds || []))}&artists=${encodeURIComponent((artists || []).join('|'))}`),
  song: (source, id) => get(`/song/${source}/${encodeURIComponent(id)}`),
  album: (source, id) => get(`/album/${source}/${encodeURIComponent(id)}`),
  artist: (source, id) => get(`/artist/${source}/${encodeURIComponent(id)}`),
  artistSongs: (name, opts = {}) => get(`/artist-songs?name=${encodeURIComponent(name || '')}`, opts),
  lyrics: ({ artist, title, duration, album }) => get(`/lyrics?artist=${encodeURIComponent(artist || '')}&title=${encodeURIComponent(title || '')}&duration=${Math.round(duration || 0)}&album=${encodeURIComponent(album || '')}`),
  party: {
    create: () => post('/party', {}),
    beat: (code, body) => post(`/party/${encodeURIComponent(code)}/beat`, body),
    get: (code) => get(`/party/${encodeURIComponent(code)}`),
    end: (code) => post(`/party/${encodeURIComponent(code)}/end`, {}),
  },
  tidalPreview: (title, artist) => `${BASE}/tidal-preview?title=${encodeURIComponent(title || '')}&artist=${encodeURIComponent(artist || '')}`,
  similar: (title, artist, limit = 12) => get(`/similar?title=${encodeURIComponent(title || '')}&artist=${encodeURIComponent(artist || '')}&limit=${limit}`),
  auth: {
    config: () => get('/auth/config'),
    google: (credential) => post('/auth/google', { credential }),
    me: () => get('/auth/me'),
    logout: () => post('/auth/logout', {}),
  },
  // fire-and-forget: warm server audio cache ahead of playback (zero-delay starts).
  // Deduped per URL (60s): standby + pool + similar + track-load all warm the
  // same tracks — one warm request per song, not four.
  warm: (streamUrl) => {
    try {
      if (!navigator.onLine) return;
      const u = String(streamUrl || '').replace('/api/audio', '/api/warm');
      if (u === streamUrl) return;
      const now = Date.now();
      const last = warmedUrls.get(u) || 0;
      if (now - last < 60000) return;
      if (warmedUrls.size > 200) warmedUrls.delete(warmedUrls.keys().next().value);
      warmedUrls.set(u, now);
      fetch(u).catch(() => {});
    } catch { /* prefetch is best-effort */ }
  },
};

// auto quality: match the tier to measured network speed (re-evaluated per track)
export function effectiveQuality(quality) {
  if (quality === 'low' || quality === 'medium' || quality === 'high') return quality;
  try {
    const et = String(navigator.connection?.effectiveType || '');
    if (/2g/.test(et)) return 'low';
    if (/3g/.test(et)) return 'medium';
  } catch { /* noop */ }
  return 'high';
}

export function streamFor(track, quality = 'high') {
  if (!track?.streamUrl) return '';
  const q = effectiveQuality(quality);
  const meta = `&t=${encodeURIComponent(track.title || '')}&ar=${encodeURIComponent(track.artist?.name || '')}`;
  return `${track.streamUrl}${track.streamUrl.includes('?') ? '&' : '?'}quality=${q}${meta}`;
}

export function parseTrackId(id) {
  // "djp:xxx" | "djp:al:xxx" | "djp:ar:slug"
  const [source, kind, ...rest] = String(id || '').split(':');
  if (rest.length) return { source, kind, id: rest.join(':') };
  return { source, kind: 'track', id: kind };
}

export function formatTime(sec = 0) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function shuffleList(arr) {
  const x = [...(arr || [])];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'Yesterday' : `${d}d ago`;
}

export function tasteFiltered(tracks, disliked = {}, hidden = {}) {
  const foldName = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (tracks || []).filter(t => !disliked[t.id] && !hidden[foldName(t.artist?.name)]);
}

export function debounce(fn, ms = 300) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
