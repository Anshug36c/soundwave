/* SoundWave service worker — app-shell caching + offline audio via Cache Storage */
const SHELL = 'soundwave-shell-v3';
const AUDIO = 'soundwave-audio-v3';
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
  // Audio: cache-first (offline playback), then network
  if (request.destination === 'audio' || url.pathname.startsWith('/api/stream')) {
    e.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(AUDIO).then((c) => c.put(request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(request))));
    return;
  }
  // API: network-first with cache fallback
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(request).then((res) => {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(request)));
    return;
  }
  // Shell: cache-first
  e.respondWith(caches.match(request).then((hit) => hit || fetch(request).catch(() => caches.match('/index.html'))));
});
