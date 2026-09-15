// Unified frontend API client — talks to the SoundWave backend aggregator.
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
  search: (q, type = 'all') => get(`/search?q=${encodeURIComponent(q)}&type=${type}`),
  song: (source, id) => get(`/song/${source}/${encodeURIComponent(id)}`),
  album: (source, id) => get(`/album/${source}/${encodeURIComponent(id)}`),
  artist: (source, id) => get(`/artist/${source}/${encodeURIComponent(id)}`),
  playlist: (source, id) => get(`/playlist/${source}/${encodeURIComponent(id)}`),
  charts: () => get('/charts'),
  underground: () => get('/underground'),
  stations: (params = {}) => get('/radio-stations' + (Object.keys(params).length ? `?${new URLSearchParams(params)}` : '')),
  alternates: (title, artist = '') => get(`/alternates?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`),
  radio: (seed) => get(`/radio?seed=${encodeURIComponent(seed)}`),
  lyrics: ({ saavnId, artist, title }) => {
    const p = new URLSearchParams();
    if (saavnId) p.set('saavnId', saavnId);
    if (artist) p.set('artist', artist);
    if (title) p.set('title', title);
    return get(`/lyrics?${p.toString()}`);
  },
  streamProxy: (url) => `${BASE}/stream?url=${encodeURIComponent(url)}`,
};

export function streamFor(track, quality = 'high') {
  if (!track) return '';
  return track.streams?.[quality] || track.streamUrl || track.previewUrl || '';
}

export function parseTrackId(id) {
  // "saavn:xxx" | "deezer:xxx" | "saavn:al:xxx" ...
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
