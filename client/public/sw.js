/* SoundWave service worker — app-shell caching + offline audio via Cache Storage.
 * Navigations are NETWORK-FIRST: a stale cached index.html referencing deleted
 * hashed assets causes white screens after deploys. Cache is offline fallback only. */
const SHELL = 'soundwave-shell-v4';
const AUDIO = 'soundwave-audio-v5'; // v5: no more auto-cached streams (explicit offline downloads only)
const SHELL_URLS = ['/', '/index.html', '/manifest.json', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, AUDIO].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Offline downloads: client posts {type:'CACHE_AUDIO', url}
self.addEventListener('message', async (e) => {
  if (e.data?.type === 'CACHE_AUDIO' && e.data.url) {
    try {
      const cache = await caches.open(AUDIO);
      await cache.add(e.data.url);
      e.source?.postMessage({ type: 'CACHED_AUDIO', url: e.data.url, ok: true });
    } catch { e.source?.postMessage({ type: 'CACHED_AUDIO', url: e.data.url, ok: false }); }
  }
  if (e.data?.type === 'UNCACHE_AUDIO' && e.data.url) {
    const cache = await caches.open(AUDIO);
    await cache.delete(e.data.url);
  }
});
self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  // Never intercept cross-origin requests (YouTube API, streams, CDNs) —
  // the offline fallback below must only serve same-origin app routes.
  if (url.origin !== self.location.origin) return;
  // Audio: serve explicit offline downloads from cache; never auto-cache streams.
  // (AUDIO v4 cached every played track; v5 caches only what the user taps Offline.)
  // Range-aware: seeks send Range requests — slice the cached file into a 206,
  // since a 200 full-body reply to a Range request fails the media load.
  if (request.destination === 'audio' || url.pathname.startsWith('/api/stream')) {
    e.respondWith((async () => {
      const hit = await caches.match(request);
      if (!hit) return fetch(request);
      const range = request.headers.get('range');
      if (!range) return hit;
      const m = range.match(/bytes=(\d*)-(\d*)/);
      const buf = await hit.arrayBuffer();
      const start = m?.[1] ? parseInt(m[1], 10) : 0;
      const end = m?.[2] ? parseInt(m[2], 10) : buf.byteLength - 1;
      if (start >= buf.byteLength || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${buf.byteLength}` } });
      }
      const e2 = Math.min(end, buf.byteLength - 1);
      return new Response(buf.slice(start, e2 + 1), {
        status: 206,
        headers: {
          'Content-Type': hit.headers.get('content-type') || 'audio/mpeg',
          'Content-Range': `bytes ${start}-${e2}/${buf.byteLength}`,
          'Content-Length': String(e2 - start + 1),
          'Accept-Ranges': 'bytes',
        },
      });
    })());
    return;
  }
  // API: network-first with cache fallback. Only small OK responses are kept
  // (never errors, never streams), capped at 60 entries so the shell cache
  // can't grow without bound.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(request).then((res) => {
      const len = parseInt(res.headers.get('content-length') || '0', 10) || 0;
      if (res.ok && (!len || len < 524288)) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => {
          c.put(request, copy).catch(() => {});
          c.keys().then((keys) => {
            const apiKeys = keys.filter((k) => { try { return new URL(k.url).pathname.startsWith('/api/'); } catch { return false; } });
            if (apiKeys.length > 60) c.delete(apiKeys[0]).catch(() => {});
          }).catch(() => {});
        }).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(request))));
    return;
  }
  // Navigations + shell: NETWORK-FIRST (prevents stale-shell white screens),
  // cache fallback keeps offline mode working.
  if (request.mode === 'navigate' || SHELL_URLS.includes(url.pathname)) {
    e.respondWith(fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(request).then((hit) => hit || caches.match('/index.html'))));
    return;
  }
  // Everything else (hashed assets): cache-first
  e.respondWith(caches.match(request).then((hit) => hit || fetch(request).catch(() => caches.match('/index.html'))));
});
