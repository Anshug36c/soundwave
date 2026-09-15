import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { api, streamFor } from '../services/musicApi';
import { ytResolve, pickFormat } from '../services/ytmusic';

// Singleton audio element (no CORS mode — plain playback works with all
// stream hosts including YouTube's googlevideo URLs)
let audio = null;
function getAudio() {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
  }
  return audio;
}

// failed YouTube format URLs: "trackId|url"
const failedYtUrls = new Set();

/**
 * Core audio engine:
 * - resolves best stream (saavn full → deezer/itunes preview; ytmusic Opus in-browser)
 * - error auto-skip with format-level fallback for YouTube, preloads next track
 * - MediaSession OS controls, keyboard shortcuts, sleep timer
 */
export function useAudioEngine() {
  const sleepTimerRef = useRef(null);

  useEffect(() => {
    const el = getAudio();
    const store = useStore;

    const onTime = () => store.getState().setTime(el.currentTime, el.duration || store.getState().duration);
    const onLoaded = () => store.getState().setTime(el.currentTime, el.duration || 0);
    const onPlay = () => store.getState().setPlaying(true);
    const onPause = () => { if (!el.ended) store.getState().setPlaying(false); };
    const onError = async () => {
      const { queue, index, next, toast } = store.getState();
      const t = queue[index];
      // YouTube Music: walk down remaining formats, then force re-resolve (expiry), then skip
      if (t?.source === 'ytmusic') {
        failedYtUrls.add(`${t.id}|${el.src}`);
        const remaining = (t.formats || []).filter(f => f.url && !failedYtUrls.has(`${t.id}|${f.url}`));
        if (remaining.length) {
          const f = remaining.sort((a, b) => b.bitrate - a.bitrate)[0];
          useStore.setState({ activeFormat: f.label });
          el.src = f.url;
          el.play().catch(() => {});
          return;
        }
        if (!t._ytReResolved) {
          try {
            const r = await ytResolve(t.sourceId, true);
            const sel = pickFormat(r.formats, useStore.getState().formatPref);
            const q = [...useStore.getState().queue];
            const idx = useStore.getState().index;
            if (q[idx]?.id === t.id) {
              q[idx] = { ...t, formats: r.formats, streams: r.streams, streamUrl: sel.url, codec: sel.codec, _ytReResolved: true };
              useStore.setState({ queue: q });
            }
            useStore.setState({ activeFormat: sel.label });
            el.src = sel.url;
            el.play().catch(() => {});
            return;
          } catch { /* fall through to skip */ }
        }
        toast('YouTube stream failed — skipping to next', 'error');
        next();
        return;
      }
      // try resolving via backend (fallback source), else skip
      if (t && !t._retried) {
        try {
          const [source, ...rest] = String(t.id).split(':');
          const full = await api.song(source, rest.join(':'));
          if (full?.streamUrl && full.streamUrl !== el.src) {
            const q = [...store.getState().queue];
            q[store.getState().index] = { ...t, ...full, _retried: true };
            useStore.setState({ queue: q });
            el.src = full.streamUrl;
            el.play().catch(() => {});
            return;
          }
        } catch { /* fall through to skip */ }
      }
      toast('Stream unavailable — skipping to next', 'error');
      next();
    };
    const onEnded = () => {
      const { repeat, next, index, queue } = store.getState();
      if (repeat === 'one') { el.currentTime = 0; el.play().catch(() => {}); return; }
      if (index >= queue.length - 1 && repeat === 'off') { store.getState().setPlaying(false); return; }
      next();
    };

    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onLoaded);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('error', onError);
    el.addEventListener('ended', onEnded);

    // expose seek helper
    useStore.setState({ _seekTo: (t) => { el.currentTime = t; } });

    // keyboard shortcuts
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      const s = store.getState();
      if (e.code === 'Space') { e.preventDefault(); s.togglePlay(); }
      else if (e.key === 'ArrowRight') el.currentTime = Math.min((el.duration || 0), el.currentTime + 10);
      else if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 10);
      else if (e.key === 'ArrowUp') { e.preventDefault(); s.setVolume(Math.min(1, +(s.volume + 0.1).toFixed(2))); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); s.setVolume(Math.max(0, +(s.volume - 0.1).toFixed(2))); }
      else if (e.key.toLowerCase() === 'm') s.setMuted(!s.muted);
      else if (e.key.toLowerCase() === 'n') s.next();
      else if (e.key.toLowerCase() === 'p') s.prev();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onLoaded);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('error', onError);
      el.removeEventListener('ended', onEnded);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // reactivity: current track / playing / volume / quality / sleep
  const index = useStore(s => s.index);
  const queue = useStore(s => s.queue);
  const isPlaying = useStore(s => s.isPlaying);
  const volume = useStore(s => s.volume);
  const muted = useStore(s => s.muted);
  const quality = useStore(s => s.quality);
  const sleepTimerMin = useStore(s => s.sleepTimerMin);
  const currentTime = useStore(s => s.currentTime);
  const srcNonce = useStore(s => s.srcNonce);

  const track = index >= 0 ? queue[index] : null;

  // load track
  useEffect(() => {
    const el = getAudio();
    if (!track) { el.pause(); el.removeAttribute('src'); el.load(); return; }
    useStore.setState({ srcOverride: null, activeFormat: null });
    let cancelled = false;
    (async () => {
      let url = streamFor(track, quality);
      // YouTube Music: resolve Opus streams in-browser
      if (track.source === 'ytmusic') {
        useStore.getState().setYtStatus('loading');
        try {
          const r = await ytResolve(track.sourceId);
          if (cancelled) return;
          const sel = pickFormat(r.formats, useStore.getState().formatPref);
          if (!sel?.url) throw new Error('No playable YouTube format');
          const q = [...useStore.getState().queue];
          const idx = useStore.getState().index;
          if (q[idx]?.id === track.id) {
            q[idx] = { ...track, formats: r.formats, streams: r.streams, streamUrl: sel.url, codec: sel.codec };
            useStore.setState({ queue: q, activeFormat: sel.label });
          }
          useStore.getState().setYtStatus('ready');
          url = sel.url;
        } catch (e) {
          if (cancelled) return;
          useStore.getState().setYtStatus('unavailable');
          useStore.getState().toast('YouTube Music unavailable on this network', 'error');
          useStore.getState().next();
          return;
        }
      }
      if (!url && track.source !== 'ytmusic') {
        // lazy-resolve full detail
        try {
          const [source, ...rest] = String(track.id).split(':');
          const kind = rest.length > 1 ? rest[0] : 'track';
          const full = await api.song(source === 'saavn' || source === 'deezer' ? source : 'saavn', kind === 'track' ? rest.join(':') : rest.slice(1).join(':')).catch(() => null);
          if (cancelled) return;
          if (full?.streamUrl) {
            const q = [...useStore.getState().queue];
            const idx = useStore.getState().index;
            if (q[idx]?.id === track.id) { q[idx] = { ...track, ...full }; useStore.setState({ queue: q }); }
            url = streamFor({ ...track, ...full }, quality);
          }
        } catch { /* noop */ }
      }
      if (cancelled) return;
      if (url && el.dataset.trackId !== track.id) {
        el.dataset.trackId = track.id;
        el.src = url;
        el.currentTime = 0;
        if (useStore.getState().isPlaying) el.play().catch(() => {});
      } else if (!url) {
        useStore.getState().toast('No playable stream for this track', 'error');
      }
      // preload next (only already-resolved URLs — YTM resolves lazily on play)
      const q = useStore.getState().queue;
      const nxt = q[useStore.getState().index + 1];
      if (nxt?.streamUrl) { const l = new Audio(); l.preload = 'auto'; l.src = streamFor(nxt, quality); }
      // media session
      if ('mediaSession' in navigator && track) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title, artist: track.artist?.name || '', album: track.album?.name || '',
            artwork: [96, 128, 192, 256, 512].map(sz => ({ src: track.image || track.thumbnails?.medium || '', sizes: `${sz}x${sz}` })),
          });
          const s = useStore.getState();
          navigator.mediaSession.setActionHandler('play', () => useStore.getState().setPlaying(true));
          navigator.mediaSession.setActionHandler('pause', () => useStore.getState().setPlaying(false));
          navigator.mediaSession.setActionHandler('previoustrack', () => s.prev());
          navigator.mediaSession.setActionHandler('nexttrack', () => s.next());
        } catch { /* noop */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  // hot-swap stream URL (format picker / preference) without restarting queue position
  useEffect(() => {
    if (!srcNonce) return;
    const { srcOverride, index: idx } = useStore.getState();
    if (!srcOverride || idx < 0) return;
    const el = getAudio();
    const t = el.currentTime || 0;
    const wasPlaying = !el.paused;
    el.src = srcOverride.url;
    try { el.currentTime = t; } catch { /* metadata not ready yet */ }
    if (wasPlaying) el.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcNonce]);

  // play/pause
  useEffect(() => {
    const el = getAudio();
    if (!track) return;
    if (isPlaying) el.play().catch(() => useStore.getState().setPlaying(false));
    else el.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, track?.id]);

  // volume
  useEffect(() => {
    const el = getAudio();
    el.volume = volume;
    el.muted = muted;
  }, [volume, muted]);

  // seek requests
  const lastSeek = useRef(-1);
  useEffect(() => {
    const el = getAudio();
    if (lastSeek.current !== currentTime && Math.abs(el.currentTime - currentTime) > 1.5 && document.activeElement?.dataset?.seeking === '1') {
      el.currentTime = currentTime;
    }
    lastSeek.current = currentTime;
  }, [currentTime]);

  // sleep timer
  useEffect(() => {
    if (sleepTimerRef.current) { clearTimeout(sleepTimerRef.current); sleepTimerRef.current = null; }
    if (sleepTimerMin > 0) {
      sleepTimerRef.current = setTimeout(() => {
        useStore.getState().setPlaying(false);
        useStore.getState().setSleepTimer(0);
        useStore.getState().toast('Sleep timer stopped playback', 'info');
      }, sleepTimerMin * 60 * 1000);
    }
    return () => { if (sleepTimerRef.current) clearTimeout(sleepTimerRef.current); };
  }, [sleepTimerMin]);

  return { track };
}

export function seekTo(t) {
  const el = getAudio();
  el.currentTime = t;
  useStore.getState().setTime(t, el.duration || useStore.getState().duration);
}
