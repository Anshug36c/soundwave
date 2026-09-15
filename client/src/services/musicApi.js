// SoundWave API client — DJPunjab-only backend.
const BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${r.status}`);
  }
  return r.json();
}

export const api = {
  health: () => get('/health'),
  home: () => get('/home'),
  search: (q, type = 'all', f = {}) => {
    const p = new URLSearchParams({ q, type });
    if (f.y) p.set('y', f.y);
    if (f.minD) p.set('minD', f.minD);
    if (f.maxD) p.set('maxD', f.maxD);
    if (f.lang) p.set('lang', f.lang);
    if (f.exp) p.set('exp', f.exp);
    return get(`/search?${p.toString()}`);
  },
  suggest: (q, limit = 8) => get(`/suggest?q=${encodeURIComponent(q)}&limit=${limit}`),
  song: (source, id) => get(`/song/${source}/${encodeURIComponent(id)}`),
  album: (source, id) => get(`/album/${source}/${encodeURIComponent(id)}`),
  artist: (source, id) => get(`/artist/${source}/${encodeURIComponent(id)}`),
  lyrics: ({ artist, title }) => get(`/lyrics?artist=${encodeURIComponent(artist || '')}&title=${encodeURIComponent(title || '')}`),
  tidalPreview: (title, artist) => `${BASE}/tidal-preview?title=${encodeURIComponent(title || '')}&artist=${encodeURIComponent(artist || '')}`,
  similar: (title, artist, limit = 12) => get(`/similar?title=${encodeURIComponent(title || '')}&artist=${encodeURIComponent(artist || '')}&limit=${limit}`),
  // fire-and-forget: warm server audio cache ahead of playback (zero-delay starts)
  warm: (streamUrl) => {
    try {
      const u = String(streamUrl || '').replace('/api/audio', '/api/warm');
      if (u !== streamUrl) fetch(u).catch(() => {});
    } catch { /* prefetch is best-effort */ }
  },
};

export function streamFor(track, quality = 'high') {
  if (!track?.streamUrl) return '';
  const q = ['high', 'medium', 'low'].includes(quality) ? quality : 'high';
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

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
