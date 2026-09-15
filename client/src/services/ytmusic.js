// YouTube Music client — runs in the USER'S browser via lazily-loaded youtubei.js.
// No server needed: search + Opus stream resolving happen client-side (residential
// IPs aren't flagged by YouTube, unlike datacenter servers).

let ytPromise = null;

export function getInnertube() {
  if (!ytPromise) {
    ytPromise = (async () => {
      const { Innertube } = await import('youtubei.js');
      const yt = await Innertube.create({});
      return yt;
    })().catch((e) => {
      ytPromise = null;
      throw e;
    });
  }
  return ytPromise;
}

function bestThumb(node) {
  const arr = node?.thumbnails || [];
  if (!arr.length) return '';
  const sorted = [...arr].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || '';
}

function videoIdOf(item) {
  return item?.id || item?.endpoint?.payload?.videoId || item?.endpoint?.payload?.video_id || '';
}

export function normalizeYtSong(item) {
  const vid = videoIdOf(item);
  const artists = (item.artists || item.authors || []).map((a) => ({
    id: `ytmusic:ar:${a.channel_id || a.name}`,
    name: a.name,
    image: '',
  }));
  const th = bestThumb(item);
  return {
    id: `ytmusic:${vid}`,
    source: 'ytmusic',
    sourceId: String(vid),
    title: item.title || 'Unknown',
    artist: artists[0] || { id: '', name: item.author?.name || 'Unknown Artist', image: '' },
    artists,
    album: {
      id: item.album?.id ? `ytmusic:al:${item.album.id}` : '',
      name: item.album?.name || '',
      image: th,
      year: item.year || '',
    },
    duration: item.duration?.seconds || 0,
    streamUrl: '',
    streams: null,
    formats: null,
    image: th,
    thumbnails: { small: th, medium: th, large: th },
    language: '',
    playCount: 0,
    explicit: false,
    hasLyrics: false,
    lyricsId: null,
    genre: [],
    url: `https://music.youtube.com/watch?v=${vid}`,
    isPreview: false,
    codec: null,
    isLiked: false,
  };
}

export async function ytSearch(query) {
  const yt = await getInnertube();
  const res = await yt.music.search(query);
  const out = { songs: [], videos: [], artists: [], albums: [] };
  out.songs = (res.songs?.contents || []).filter((i) => videoIdOf(i)).map(normalizeYtSong);
  out.videos = (res.videos?.contents || []).filter((i) => videoIdOf(i)).map(normalizeYtSong);
  out.artists = (res.artists?.contents || []).map((a) => ({
    id: `ytmusic:ar:${a.id || ''}`,
    source: 'ytmusic',
    sourceId: String(a.id || ''),
    type: 'artist',
    name: a.title || a.name || 'Unknown Artist',
    image: bestThumb(a),
    thumbnails: {},
    role: a.subscribers || '',
  })).filter((a) => a.name && a.name !== 'Unknown Artist');
  out.albums = (res.albums?.contents || []).map((a) => ({
    id: `ytmusic:al:${a.id || ''}`,
    source: 'ytmusic',
    sourceId: String(a.id || ''),
    type: 'album',
    name: a.title || a.name || 'Unknown Album',
    artist: (a.artists || [])[0]?.name || a.subtitle?.text || '',
    image: bestThumb(a),
    thumbnails: {},
    year: a.year || '',
    songCount: 0,
  })).filter((a) => a.name && a.name !== 'Unknown Album');
  [...out.artists, ...out.albums].forEach((x) => { x.thumbnails = { small: x.image, medium: x.image, large: x.image }; });
  return out;
}

const ITAG_CODEC = {
  251: ['opus', 'webm'], 250: ['opus', 'webm'], 249: ['opus', 'webm'],
  140: ['aac', 'm4a'], 141: ['aac', 'm4a'], 139: ['aac', 'm4a'],
  256: ['aac', 'm4a'], 258: ['aac', 'm4a'], 325: ['dtse', 'm4a'], 328: ['dtse', 'm4a'],
};

export function classifyYtFormat(f) {
  const mt = String(f.mime_type || '').toLowerCase();
  if (mt.includes('opus')) return { codec: 'opus', container: 'webm' };
  if (mt.includes('mp4a') || mt.includes('mp4')) return { codec: 'aac', container: 'm4a' };
  if (mt.includes('ec-3') || mt.includes('ac-3')) return { codec: 'ac3', container: 'm4a' };
  const hit = ITAG_CODEC[f.itag];
  if (hit) return { codec: hit[0], container: hit[1] };
  return { codec: 'audio', container: '' };
}

const resolveCache = new Map(); // videoId -> { formats, streams, expiresAt }

export async function ytResolve(videoId, force = false) {
  const hit = resolveCache.get(videoId);
  if (!force && hit && hit.expiresAt > Date.now()) return hit;
  const yt = await getInnertube();
  const info = await yt.music.getInfo(videoId);
  const status = info.playability_status?.status;
  if (status && status !== 'OK') {
    throw new Error(info.playability_status?.reason || 'YouTube Music blocked this track');
  }
  const sd = info.streaming_data;
  const audio = (sd?.adaptive_formats || []).filter((f) => f.has_audio && !f.has_video && !f.is_type_otf);
  if (!audio.length) throw new Error('No YouTube Music audio streams found');
  audio.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const player = yt.session.player;
  const out = [];
  for (const f of audio.slice(0, 6)) {
    try {
      const url = f.url || (await f.decipher(player));
      if (!url) continue;
      const { codec, container } = classifyYtFormat(f);
      const kb = Math.round((f.bitrate || f.average_bitrate || 0) / 1000);
      out.push({
        label: `${codec.toUpperCase()}${kb ? ` ${kb}k` : ''}`,
        codec, container,
        bitrate: f.bitrate || f.average_bitrate || 0,
        itag: f.itag,
        url,
      });
    } catch { /* skip undecipherable */ }
  }
  if (!out.length) throw new Error('Could not unlock YouTube Music streams');
  const seen = new Set();
  const formats = out.filter((f) => {
    const k = `${f.codec}:${f.bitrate}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const byBit = [...formats].sort((a, b) => b.bitrate - a.bitrate);
  let expiresAt = Date.now() + 5 * 3600 * 1000;
  const exp = sd?.expires;
  if (exp instanceof Date) expiresAt = Math.min(expiresAt, exp.getTime() - 5 * 60 * 1000);
  const result = {
    formats,
    streams: {
      high: byBit[0]?.url || '',
      medium: byBit[Math.floor(byBit.length / 2)]?.url || byBit[0]?.url || '',
      low: byBit[byBit.length - 1]?.url || '',
    },
    expiresAt,
  };
  if (resolveCache.size > 100) resolveCache.clear();
  resolveCache.set(videoId, result);
  return result;
}

export function pickFormat(formats, pref = 'auto') {
  if (!formats?.length) return null;
  const sorted = [...formats].sort((a, b) => b.bitrate - a.bitrate);
  if (pref === 'opus') return sorted.find((f) => f.codec === 'opus') || sorted[0];
  if (pref === 'm4a' || pref === 'aac') return sorted.find((f) => f.codec === 'aac') || sorted[0];
  return sorted[0];
}

export async function ytTrending() {
  const r = await ytSearch('top hits 2026 global');
  const songs = r.songs.length ? r.songs : r.videos;
  return songs.slice(0, 12);
}
