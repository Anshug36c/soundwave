import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { api, streamFor } from '../services/musicApi';
import * as studio from '../audio/studio';

// Singleton audio element (plain playback). WebAudio routing is permanent per
// element, so toggling Studio mode recreates it (see recreateAudio).
let audio = null;
function getAudio() {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
  }
  return audio;
}

// auto-upgrade cache: preview trackId -> full track | null
const upgradeCache = new Map();
let upgradeToastShown = false;

/** Smooth volume ramp (crossfade / sleep fade-out). */
function fadeVolume(el, to, ms) {
  return new Promise(resolve => {
    const from = el.volume;
    if (Math.abs(from - to) < 0.02 || ms <= 0) { el.volume = to; resolve(); return; }
    const steps = 14;
    let i = 0;
    const t = setInterval(() => {
      i++;
      try { el.volume = from + (to - from) * (i / steps); } catch { /* noop */ }
      if (i >= steps) { clearInterval(t); try { el.volume = to; } catch { /* noop */ } resolve(); }
    }, ms / steps);
  });
}

/** Find a FULL version of a preview track via server alternates (DJPunjab / Audius / Archive). */
async function upgradeToFull(track) {
  if (upgradeCache.has(track.id)) return upgradeCache.get(track.id);
  const done = (v) => { if (upgradeCache.size > 100) upgradeCache.clear(); upgradeCache.set(track.id, v); return v; };
  try {
    const r = await fetch(`/api/alternates?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist?.name || '')}`);
    if (r.ok) {
      const j = await r.json();
      if (j.track?.streamUrl) {
        return done({ ...j.track, id: track.id, upgradedFrom: track.source });
      }
    }
  } catch { /* keep preview */ }
  return done(null);
}

// ---------- module-scope event handlers (survive element recreation) ----------
function onTime() {
  const el = getAudio();
  useStore.getState().setTime(el.currentTime, el.duration || useStore.getState().duration);
}
function onLoaded() {
  const el = getAudio();
  useStore.getState().setTime(el.currentTime, el.duration || 0);
}
function onPlay() { useStore.getState().setPlaying(true); }
function onPause() { const el = getAudio(); if (!el.ended) useStore.getState().setPlaying(false); }
async function onError() {
  const el = getAudio();
  const store = useStore;
  const { queue, index, next, toast } = store.getState();
  const t = queue[index];
  // Studio proxy failed: fall back to a FRESH plain element + direct URL
  if (t && el.src.includes('/api/stream') && !t._studioFellBack) {
    const direct = streamFor(t, store.getState().quality) || t.streamUrl || '';
    if (direct) {
      const q = [...store.getState().queue];
      q[store.getState().index] = { ...t, _studioFellBack: true };
      useStore.setState({ queue: q });
      const nel = recreateAudio();
      nel.dataset.trackId = t.id;
      nel.src = direct;
      nel.play().catch(() => {});
      toast('Studio bypassed for this stream', 'info');
      return;
    }
  }
  // try resolving via backend (same-id-space sources only — never cross-wire ids), else skip
  if (t && !t._retried) {
    const [source, ...rest] = String(t.id).split(':');
    if (!['saavn', 'deezer', 'itunes'].includes(source)) {
      toast('Stream unavailable — skipping to next', 'error');
      next();
      return;
    }
    try {
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
}
function onEnded() {
  const el = getAudio();
  const { repeat, next, index, queue } = useStore.getState();
  if (repeat === 'one') { el.currentTime = 0; el.play().catch(() => {}); return; }
  if (index >= queue.length - 1 && repeat === 'off') { useStore.getState().setPlaying(false); return; }
  next();
}
function onKey(e) {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return; // palette handles it
  const el = getAudio();
  const s = useStore.getState();
  if (e.code === 'Space') { e.preventDefault(); s.togglePlay(); }
  else if (e.key === 'ArrowRight') el.currentTime = Math.min((el.duration || 0), el.currentTime + 10);
  else if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 10);
  else if (e.key === 'ArrowUp') { e.preventDefault(); s.setVolume(Math.min(1, +(s.volume + 0.1).toFixed(2))); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); s.setVolume(Math.max(0, +(s.volume - 0.1).toFixed(2))); }
  else if (e.key.toLowerCase() === 'm') s.setMuted(!s.muted);
  else if (e.key.toLowerCase() === 'n') s.next();
  else if (e.key.toLowerCase() === 'p') s.prev();
}

function attachAudio(el) {
  el.addEventListener('timeupdate', onTime);
  el.addEventListener('loadedmetadata', onLoaded);
  el.addEventListener('play', onPlay);
  el.addEventListener('pause', onPause);
  el.addEventListener('error', onError);
  el.addEventListener('ended', onEnded);
}
function detachAudio(el) {
  el.removeEventListener('timeupdate', onTime);
  el.removeEventListener('loadedmetadata', onLoaded);
  el.removeEventListener('play', onPlay);
  el.removeEventListener('pause', onPause);
  el.removeEventListener('error', onError);
  el.removeEventListener('ended', onEnded);
}
function recreateAudio() {
  if (audio) {
    try { detachAudio(audio); audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* noop */ }
  }
  const el = new Audio();
  el.preload = 'auto';
  el.volume = useStore.getState().muted ? 0 : useStore.getState().volume;
  el.muted = useStore.getState().muted;
  audio = el;
  attachAudio(el);
  return el;
}

/**
 * Core audio engine:
 * - Studio mode (WebAudio EQ + visualizer via proxied streams), crossfade, sleep fade-out
 * - auto-upgrades previews to full tracks (DJPunjab / Audius / Archive)
 * - error auto-skip, preloads next track
 * - MediaSession OS controls, keyboard shortcuts
 */
export function useAudioEngine() {
  const sleepTimerRef = useRef(null);

  useEffect(() => {
    attachAudio(getAudio());
    useStore.setState({ _seekTo: (t) => { getAudio().currentTime = t; } });
    window.addEventListener('keydown', onKey);
    return () => {
      detachAudio(getAudio());
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // reactivity: current track / playing / volume / quality / sleep / studio
  const index = useStore(s => s.index);
  const queue = useStore(s => s.queue);
  const isPlaying = useStore(s => s.isPlaying);
  const volume = useStore(s => s.volume);
  const muted = useStore(s => s.muted);
  const quality = useStore(s => s.quality);
  const sleepTimerMin = useStore(s => s.sleepTimerMin);
  const currentTime = useStore(s => s.currentTime);
  const studioOn = useStore(s => s.studioOn);

  const track = index >= 0 ? queue[index] : null;

  // load track
  useEffect(() => {
    const el = getAudio();
    if (!track) { el.pause(); el.removeAttribute('src'); el.load(); return; }
    let cancelled = false;
    (async () => {
      let url = streamFor(track, quality);
      if (!url && ['saavn', 'deezer', 'itunes'].includes(track.source)) {
        // lazy-resolve full detail (same-id-space sources only)
        try {
          const [source, ...rest] = String(track.id).split(':');
          const full = await api.song(source, rest.join(':')).catch(() => null);
          if (cancelled) return;
          if (full?.streamUrl) {
            const q = [...useStore.getState().queue];
            const idx = useStore.getState().index;
            if (q[idx]?.id === track.id) { q[idx] = { ...track, ...full }; useStore.setState({ queue: q }); }
            url = streamFor({ ...track, ...full }, quality);
          }
        } catch { /* noop */ }
      }
      // Auto-upgrade previews → full tracks (keeps original id so playback continues seamlessly)
      if (url && useStore.getState().preferFull && track.isPreview && !track.upgradedFrom && track.source !== 'radio') {
        const up = await upgradeToFull(track);
        if (cancelled) return;
        if (up?.streamUrl) {
          const q2 = [...useStore.getState().queue];
          const idx2 = useStore.getState().index;
          if (q2[idx2]?.id === track.id) {
            q2[idx2] = up;
            useStore.setState({ queue: q2 });
          }
          url = up.streamUrl;
          if (!upgradeToastShown) { upgradeToastShown = true; useStore.getState().toast('Auto-upgraded to full track 🔊'); }
        }
      }
      if (cancelled) return;
      if (!url) {
        useStore.getState().toast('No playable stream for this track', 'error');
        return;
      }
      // Studio mode: route through WebAudio graph + same-origin proxy (CORS-clean)
      const st = useStore.getState();
      let playUrl = url;
      if (st.studioOn && !track._studioFellBack) {
        try {
          studio.ensureGraph(el);
          studio.syncFromState({ gains: st.eqGains, preamp: st.eqPreamp, enabled: st.eqEnabled, normalize: st.normalizeOn });
          studio.resume();
          playUrl = api.streamProxy(url);
        } catch { /* plain fallback */ }
      }
      if (el.dataset.trackId !== track.id) {
        const doFade = st.crossfade && !st.muted && el.src && !el.paused && el.currentTime > 1;
        if (doFade) {
          await fadeVolume(el, 0, 350);
          if (cancelled) return;
        } else if (st.crossfade && !st.muted) {
          el.volume = 0; // fade-in from silence on fresh loads too
        }
        el.dataset.trackId = track.id;
        el.src = playUrl;
        el.currentTime = 0;
        if (useStore.getState().isPlaying) { try { await el.play(); } catch { /* noop */ } }
        if (st.crossfade && !st.muted) fadeVolume(el, st.volume, 600);
        else el.volume = st.muted ? 0 : st.volume;
      }
      // preload next (only already-resolved URLs)
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

  // Studio toggle: recreate element (routing is permanent) + swap proxied/direct URL, keep position
  useEffect(() => {
    const el = getAudio();
    if (!track || !el.src) return;
    const st = useStore.getState();
    const direct = streamFor(track, st.quality) || track.streamUrl || '';
    if (!direct) return;
    const t = el.currentTime || 0;
    const wasPlaying = !el.paused;
    const nel = recreateAudio();
    nel.dataset.trackId = track.id;
    if (studioOn && !track._studioFellBack) {
      try {
        studio.ensureGraph(nel);
        studio.syncFromState({ gains: st.eqGains, preamp: st.eqPreamp, enabled: st.eqEnabled, normalize: st.normalizeOn });
        studio.resume();
        nel.src = api.streamProxy(direct);
      } catch { nel.src = direct; }
    } else {
      nel.src = direct;
    }
    try { nel.currentTime = t; } catch { /* metadata not ready yet */ }
    if (wasPlaying) nel.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioOn]);

  // play/pause
  useEffect(() => {
    const el = getAudio();
    if (!track) return;
    if (isPlaying) {
      studio.resume();
      el.play().catch(() => useStore.getState().setPlaying(false));
    } else el.pause();
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

  // sleep timer (fades out gently, then stops)
  useEffect(() => {
    if (sleepTimerRef.current) { clearTimeout(sleepTimerRef.current); sleepTimerRef.current = null; }
    if (sleepTimerMin > 0) {
      sleepTimerRef.current = setTimeout(async () => {
        const el = getAudio();
        const s = useStore.getState();
        if (!s.muted) await fadeVolume(el, 0, 3000);
        s.setPlaying(false);
        s.setSleepTimer(0);
        el.volume = s.muted ? 0 : s.volume;
        s.toast('Sleep timer stopped playback', 'info');
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
