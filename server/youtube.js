// YouTube search and metadata over the public InnerTube API.
//
// WHAT IS NOT HERE, AND WHY
// -------------------------
// There is no stream-URL extraction in this file. It was tried and it does not
// work, so the reasoning is recorded rather than left to be rediscovered:
//
//   - youtubei/v1/player returns playabilityStatus UNPLAYABLE with zero
//     formats on every client (WEB, ANDROID, IOS, TVHTML5_SIMPLY_EMBEDDED).
//   - The watch page still embeds a ytInitialPlayerResponse with 27 formats,
//     but those objects carry only metadata — no `url` and no
//     `signatureCipher`. There is nothing to fetch.
//   - @distube/ytdl-core and youtubei.js both fail the same way.
//
// YouTube now requires a proof-of-origin token that only a real browser
// session can produce. So playback goes through YouTube's own IFrame Player
// instead: the client embeds the official player and this module only supplies
// the catalogue. That is also the only path that works inside the APK, which
// bundles a Node runtime and nothing else — no Python for yt-dlp, no ffmpeg.
//
// Search and metadata do work from a plain server, which is what this file
// does. Both are verified against the live API by test/youtube.test.js.

const YT_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Filter to videos only. Without it a search returns channels, playlists and
// shelves mixed in, which the card grid cannot render.
const PARAMS_VIDEO_ONLY = 'EgIQAQ==';

async function innertube(endpoint, body, { timeout = 12000, key = YT_KEY } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeout);
  try {
    const url = `https://www.youtube.com/youtubei/v1/${endpoint}?key=${key}&prettyPrint=false`;
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`innertube ${endpoint} HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

const webContext = () => ({
  client: { clientName: 'WEB', clientVersion: '2.20260917.01.00', hl: 'en', gl: 'US' },
});

/** "4:28" / "1:02:11" -> seconds. 0 when the video is a live stream. */
export function parseDuration(text) {
  const parts = String(text || '').trim().split(':').map((n) => parseInt(n, 10));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/**
 * Shapes a YouTube video into the same track object the rest of the app uses,
 * so cards, queue, likes and history all work unchanged.
 *
 * `streamUrl` is deliberately empty: the audio engine treats an empty
 * streamUrl as "this track is not played through the <audio> element" and
 * hands it to the YouTube player instead.
 */
export function toTrack({ id, title, channel, duration = 0, views = 0, thumb = '' }) {
  const vid = String(id || '');
  return {
    id: `ytv:${vid}`,
    source: 'ytv',
    sourceId: vid,
    type: 'video',
    title: String(title || 'Unknown'),
    artist: { id: '', name: String(channel || 'YouTube'), image: '' },
    artists: [],
    album: { id: '', name: 'YouTube', image: '' },
    duration: Number(duration) || 0,
    image: thumb || (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : ''),
    streamUrl: '',
    previewUrl: '',
    isPreview: false,
    codec: '',
    quality: '',
    explicit: false,
    year: '',
    language: '',
    plays: Number(views) || 0,
    ytId: vid,
    kind: 'video',
  };
}

function bestThumb(thumbnails, vid) {
  const list = Array.isArray(thumbnails) ? thumbnails : [];
  const pick = list[list.length - 1]?.url || list[0]?.url || '';
  // Strip YouTube's sizing query so the CDN returns the plain image; the
  // Android artwork downloader follows redirects but not signed variants.
  return pick ? pick.split('?')[0] : (vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '');
}

/**
 * Searches YouTube for videos.
 *
 * Skips live streams and shorts-only results without a duration: they have no
 * meaningful length, which breaks the progress bar and the queue's timing.
 */
export async function ytVideoSearch(q, limit = 12) {
  const query = String(q || '').trim();
  if (!query) return [];
  const j = await innertube('search', {
    context: webContext(),
    query,
    params: PARAMS_VIDEO_ONLY,
  });

  const out = [];
  const seen = new Set();
  const walk = (o) => {
    if (!o || out.length >= limit) return;
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (typeof o !== 'object') return;
    const v = o.videoRenderer;
    if (v && v.videoId) {
      const vid = String(v.videoId);
      const title = (v.title?.runs || []).map((r) => r.text).join('');
      const channel = (v.ownerText?.runs || []).map((r) => r.text).join('')
        || (v.longBylineText?.runs || []).map((r) => r.text).join('');
      const duration = parseDuration(v.lengthText?.simpleText || v.lengthText?.runs?.[0]?.text);
      const views = parseInt(String(v.viewCountText?.simpleText || '').replace(/[^\d]/g, ''), 10) || 0;
      if (vid && title && !seen.has(vid) && duration > 0) {
        seen.add(vid);
        out.push(toTrack({ id: vid, title, channel, duration, views, thumb: bestThumb(v.thumbnail?.thumbnails, vid) }));
      }
      if (out.length >= limit) return;
    }
    for (const val of Object.values(o)) walk(val);
  };
  walk(j.contents);
  return out;
}

const infoCache = new Map(); // videoId -> { track, time }
const INFO_TTL = 10 * 60 * 1000;

/**
 * Metadata for one video, for deep links and for refreshing a queued track.
 *
 * Uses the watch page rather than the /player endpoint: /player is bot-walled
 * and answers UNPLAYABLE, but it still carries `videoDetails`, which is all
 * that is needed here.
 */
export async function ytVideoInfo(id) {
  const vid = String(id || '').trim();
  if (!/^[\w-]{6,20}$/.test(vid)) return null;
  const hit = infoCache.get(vid);
  if (hit && Date.now() - hit.time < INFO_TTL) return hit.track;

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(vid)}&hl=en`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en' },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:\s*<\/script>|\s*var\s)/s);
    if (!m) return null;
    let pr;
    try { pr = JSON.parse(m[1]); } catch { return null; }
    const d = pr.videoDetails;
    if (!d) return null;
    const track = toTrack({
      id: d.videoId || vid,
      title: d.title,
      channel: d.author,
      duration: parseInt(d.lengthSeconds, 10) || 0,
      views: parseInt(d.viewCount, 10) || 0,
      thumb: bestThumb(d.thumbnail?.thumbnails, d.videoId || vid),
    });
    if (infoCache.size > 300) infoCache.delete(infoCache.keys().next().value);
    infoCache.set(vid, { track, time: Date.now() });
    return track;
  } finally {
    clearTimeout(to);
  }
}
