import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { api, streamFor, diag } from '../services/musicApi';
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

// ---------- single-owner playback control ----------
// Every play()/pause() decision flows through syncPlayback with a monotonically
// increasing token, so overlapping async play() promises can never fight each
// other (the old play/pause flicker). Stale promise outcomes are ignored.
let playToken = 0;
function syncPlayback() {
  const el = getAudio();
  const st = useStore.getState();
  const t = ++playToken;
  if (!st.isPlaying) {
    try { el.pause(); } catch { /* noop */ }
    return;
  }
  if (!el.src) return;
  if (!el.paused && !el.ended) return; // already playing — don't re-issue play()
  let p = null;
  try { p = el.play(); } catch { /* noop */ }
  if (p && typeof p.then === 'function') {
    p.then(() => {
      // a newer decision superseded us while play() was in flight
      if (t !== playToken && useStore.getState().isPlaying === false) {
        try { getAudio().pause(); } catch { /* noop */ }
      }
    }).catch(() => {
      // only the latest decision may flip UI state; stale rejections are noise
      if (t === playToken) useStore.getState().setPlaying(false);
    });
  }
}

// Instant-preview race state (module scope — survives element recreation)
let playMode = 'full'; // 'preview' | 'full'
let fullUrl = '';
let bgAudio = null;
let swapping = false;
// ---------- prefetch: retained preload pool + server warm for instant next-track starts ----------
const preloadPool = [];
function preloadTrack(track, quality) {
  if (!track?.streamUrl) return;
  try { if (!navigator.onLine) return; } catch { /* noop */ }
  try { api.warm(streamFor(track, quality)); } catch { /* noop */ }
  try { if (navigator.connection?.saveData) return; } catch { /* noop */ }
  try {
    const a = new Audio();
    a.preload = 'auto';
    a.src = streamFor(track, quality);
    a.load();
    preloadPool.push(a);
    const st = useStore.getState();
    if (st.instantPreview && track.title && track.artist?.name) {
      try {
        const p = new Audio();
        p.preload = 'auto';
        p.src = api.tidalPreview(track.title, track.artist.name);
        p.load();
        preloadPool.push(p);
      } catch { /* noop */ }
    }
    while (preloadPool.length > 8) {
      const old = preloadPool.shift();
      try { old.removeAttribute('src'); old.load(); } catch { /* noop */ }
    }
  } catch { /* noop */ }
}
// ---------- hot standby: next track staged to canplaythrough BEFORE current ends ----------
// queue advances then cut instantly (no fade-out stall, no src-set buffering gap)
let standbyAudio = null, standbyFor = '', standbyQ = '', standbyReady = false;
let standbySettledFor = '', upcomingKey = '';
function teardownStandby() {
  if (standbyAudio) {
    try { standbyAudio.removeAttribute('src'); standbyAudio.load(); } catch { /* noop */ }
    standbyAudio = null;
  }
  standbyFor = ''; standbyReady = false; standbySettledFor = '';
}
function settleStandby(id) {
  if (!id || standbySettledFor === id) return;
  standbySettledFor = id;
  try { refreshUpcoming(); } catch { /* noop */ } // n1 settled → now stage n2
}
function armStandby(track, quality) {
  const id = track?.id || '';
  if (standbyFor === id && standbyQ === quality) return; // already staging this one
  teardownStandby();
  if (!track?.streamUrl) return;
  try { if (!navigator.onLine) return; } catch { /* noop */ }
  standbyFor = id; standbyQ = quality; standbyReady = false;
  const url = streamFor(track, quality);
  try { api.warm(url); } catch { /* noop */ }
  let saveData = false;
  try { saveData = !!navigator.connection?.saveData; } catch { /* noop */ }
  if (saveData) { settleStandby(id); return; } // server is warm; spare the user's metered bytes
  try {
    const a = new Audio();
    a.preload = 'auto';
    a.addEventListener('canplaythrough', () => { if (standbyFor === id) { standbyReady = true; settleStandby(id); } });
    a.addEventListener('error', () => { if (standbyFor === id) { standbyReady = false; settleStandby(id); } });
    a.src = url;
    a.load();
    standbyAudio = a;
    setTimeout(() => { if (standbyFor === id) settleStandby(id); }, 30000); // never stall n2 past 30s
  } catch { /* noop */ }
  try {
    const st = useStore.getState();
    if (st.instantPreview && track.title && track.artist?.name) {
      const p = new Audio();
      p.preload = 'auto';
      p.src = api.tidalPreview(track.title, track.artist.name);
      p.load();
      preloadPool.push(p);
      while (preloadPool.length > 8) {
        const old = preloadPool.shift();
        try { old.removeAttribute('src'); old.load(); } catch { /* noop */ }
      }
    }
  } catch { /* noop */ }
}
function neighborAt(off) {
  const st = useStore.getState();
  const q = st.queue, ix = st.index;
  if (!q.length || ix < 0) return null;
  if (ix + off < q.length) return q[ix + off];
  if (st.repeat !== 'off') return q[(ix + off) % q.length]; // wrapped repeat target
  return null;
}
function refreshUpcoming() {
  const st = useStore.getState();
  const n1 = neighborAt(1), n2 = neighborAt(2);
  // settled flag is part of the key: when n1 finishes staging, we re-run to stage n2
  const key = `${st.shuffle ? 'S' : ''}|${st.quality}|${n1?.id || ''}|${n2?.id || ''}|${standbySettledFor}`;
  if (key === upcomingKey) return; // nothing changed around us
  upcomingKey = key;
  if (st.shuffle) { teardownStandby(); return; } // next is random — don't stage wrong tracks
  if (n1) armStandby(n1, st.quality);
  else teardownStandby();
  // stagger: n2 only starts once n1 has settled, so preloads never gang up
  // on the bandwidth the currently playing track needs
  const n1Settled = !n1 || standbySettledFor === (n1.id || '');
  if (n2 && n1Settled) { try { preloadTrack(n2, st.quality); } catch { /* noop */ } }
}
function cleanupBg() {
  if (bgAudio) {
    try { bgAudio.pause(); bgAudio.removeAttribute('src'); bgAudio.load(); } catch { /* noop */ }
    bgAudio = null;
  }
}
/** Swap preview -> full MP3 at the same position once the full file can play. */
function trySwapToFull() {
  if (swapping || playMode !== 'preview' || !fullUrl || !bgAudio) return;
  const el = getAudio();
  let buffered = 0;
  try { if (bgAudio.buffered.length) buffered = bgAudio.buffered.end(bgAudio.buffered.length - 1); } catch { /* noop */ }
  if (bgAudio.readyState < 3 && buffered < 8) return;
  const t = el.currentTime || 0;
  if (t > 26) return; // let the preview finish — ended handler takes full from 0
  swapping = true;
  playMode = 'full';
  el.src = fullUrl;
  // currentTime must be set AFTER metadata is ready, else the track restarts at 0
  const applyTime = () => { try { el.currentTime = t; } catch { /* noop */ } };
  if (el.readyState >= 1) applyTime();
  else el.addEventListener('loadedmetadata', applyTime, { once: true });
  cleanupBg();
  syncPlayback();
  swapping = false;
}

// currentTime throws InvalidStateError when metadata isn't loaded — never let a seek crash playback
function safeCurrentTime(el, t) {
  try {
    if (!el || !el.src) return;
    el.currentTime = t;
  } catch { /* not seekable yet */ }
}
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

// ---------- sleep timer (timestamp-based: survives background-tab throttling) ----------
let sleepTimerEndsAt = 0;
let sleepFiring = false;
async function fireSleepTimer() {
  if (sleepFiring) return;
  sleepFiring = true;
  try {
    const el = getAudio();
    const s = useStore.getState();
    if (s.isPlaying && !s.muted) await fadeVolume(el, 0, 3000);
    s.setPlaying(false);
    s.setSleepTimer(0);
    el.volume = s.muted ? 0 : s.volume;
    s.toast('Sleep timer stopped playback', 'info');
  } catch { /* noop */ }
  sleepFiring = false;
}

// ---------- module-scope event handlers (survive element recreation) ----------
let lastPosState = 0;
let lastProgressAt = 0, recoverCount = 0, lastRecoverAt = 0;
function onTime() {
  const el = getAudio();
  const st = useStore.getState();
  lastProgressAt = Date.now();
  st.setTime(el.currentTime, el.duration || st.duration);
  try {
    if ('mediaSession' in navigator && el.duration && isFinite(el.duration)) {
      const now = Date.now();
      if (now - lastPosState > 1000) {
        lastPosState = now;
        navigator.mediaSession.setPositionState({
          duration: el.duration, playbackRate: el.playbackRate || 1,
          position: Math.min(el.currentTime || 0, el.duration),
        });
      }
    }
  } catch { /* noop */ }
  if (sleepTimerEndsAt && Date.now() >= sleepTimerEndsAt) { sleepTimerEndsAt = 0; fireSleepTimer(); }
  // late pre-stage: long track or seek — re-verify next is hot past the halfway mark
  try {
    if (el.duration > 30 && el.currentTime > el.duration * 0.55) refreshUpcoming();
  } catch { /* noop */ }
}
function onLoaded() {
  const el = getAudio();
  useStore.getState().setTime(el.currentTime, el.duration || 0);
}
function onPlay() {
  useStore.getState().setPlaying(true);
  try { navigator.mediaSession.playbackState = 'playing'; } catch { /* noop */ }
}
function onPause() {
  const el = getAudio();
  if (!el.ended && el.readyState > 0) useStore.getState().setPlaying(false);
  try { navigator.mediaSession.playbackState = 'paused'; } catch { /* noop */ }
}
let recentErrors = [];
function onError() {
  // preview failed (no Tidal match etc.) — fall through to the full MP3
  if (playMode === 'preview' && fullUrl) {
    playMode = 'full';
    const el = getAudio();
    el.src = fullUrl;
    el.currentTime = 0;
    cleanupBg();
    syncPlayback();
    return;
  }
  const s = useStore.getState();
  // guard: if everything is failing, stop instead of skip-looping forever
  const now = Date.now();
  recentErrors = recentErrors.filter(t => now - t < 15000);
  recentErrors.push(now);
  if (recentErrors.length >= 4) {
    recentErrors = [];
    s.setPlaying(false);
    s.toast('Playback keeps failing — check your connection', 'error');
    return;
  }
  // one silent retry per track (transient 502s) before giving up on it
  const curId = s.queue[s.index]?.id || '';
  if (errRetryFor !== curId) {
    errRetryFor = curId;
    try { getAudio().load(); } catch { /* noop */ }
    syncPlayback();
    return;
  }
  s.toast('Stream unavailable — skipping to next', 'error');
  s.next();
}
let errRetryFor = '';
function onEnded() {
  // preview finished before full was ready — start the full MP3 from 0
  if (playMode === 'preview' && fullUrl) {
    playMode = 'full';
    const el = getAudio();
    el.src = fullUrl;
    el.currentTime = 0;
    cleanupBg();
    syncPlayback();
    return;
  }
  const el = getAudio();
  const { repeat, next, index, queue } = useStore.getState();
  if (repeat === 'one') { el.currentTime = 0; syncPlayback(); return; }
  if (index >= queue.length - 1 && repeat === 'off') { useStore.getState().setPlaying(false); return; }
  next();
}
function onKey(e) {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return; // palette handles it
  const el = getAudio();
  const s = useStore.getState();
  if (e.code === 'Space') { e.preventDefault(); s.togglePlay(); }
  else if (e.key === 'ArrowRight') safeCurrentTime(el, Math.min((el.duration || 0), el.currentTime + 10));
  else if (e.key === 'ArrowLeft') safeCurrentTime(el, Math.max(0, el.currentTime - 10));
  else if (e.key === 'ArrowUp') { e.preventDefault(); s.setVolume(Math.min(1, +(s.volume + 0.1).toFixed(2))); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); s.setVolume(Math.max(0, +(s.volume - 0.1).toFixed(2))); }
  else if (e.key.toLowerCase() === 'm') s.setMuted(!s.muted);
  else if (e.key.toLowerCase() === 'n') s.next();
  else if (e.key.toLowerCase() === 'p') s.prev();
  else if (e.key.toLowerCase() === 's') s.toggleShuffle();
  else if (e.key.toLowerCase() === 'r') s.cycleRepeat();
  else if (e.key.toLowerCase() === 'q') s.setShowQueue(!s.showQueue);
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
  try { el.playbackRate = useStore.getState().playbackRate || 1; } catch { /* noop */ }
  audio = el;
  attachAudio(el);
  return el;
}

/**
 * Core audio engine:
 * - single-owner playback (syncPlayback) — no overlapping play() races
 * - instant FLAC preview first (when enabled), auto-swaps to full MP3 at same
 *   position as soon as it can play — falls back to full-only on any failure
 * - all streams same-origin; crossfade, sleep fade-out, preloads next track
 * - MediaSession OS controls, keyboard shortcuts
 */
export function useAudioEngine() {
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
  const playbackRate = useStore(s => s.playbackRate);
  const quality = useStore(s => s.quality);
  const sleepTimerMin = useStore(s => s.sleepTimerMin);
  const currentTime = useStore(s => s.currentTime);
  const studioOn = useStore(s => s.studioOn);
  const repeat = useStore(s => s.repeat);
  const shuffle = useStore(s => s.shuffle);

  const track = index >= 0 ? queue[index] : null;

  // load track: set src only — syncPlayback (play/pause effect) owns playback
  useEffect(() => {
    const el = getAudio();
    cleanupBg();
    playMode = 'full';
    fullUrl = '';
    swapping = false;
    if (!track) { el.pause(); el.removeAttribute('src'); el.load(); useStore.getState().setPlaying(false); document.title = 'SoundWave — Music for Everyone'; return; }
    let cancelled = false;
    (async () => {
      const url = streamFor(track, quality);
      if (cancelled) return;
      if (!url) {
        useStore.getState().toast('No playable stream for this track', 'error');
        return;
      }
      const st = useStore.getState();
      try { document.title = `${track.title} — ${track.artist?.name || ''} · SoundWave`; } catch { /* noop */ }
      if (st.studioOn) {
        try {
          studio.ensureGraph(el);
          studio.syncFromState({ gains: st.eqGains, preamp: st.eqPreamp, enabled: st.eqEnabled, normalize: st.normalizeOn });
          studio.resume();
        } catch { /* plain fallback */ }
      }
      if (el.dataset.trackId !== track.id) {
        const hot = standbyReady && standbyFor === track.id;
        const doFade = st.crossfade && !st.muted && el.src && !el.paused && el.currentTime > 1 && !hot;
        if (doFade) {
          await fadeVolume(el, 0, 350);
          if (cancelled) return;
        } else if (st.crossfade && !st.muted) {
          el.volume = 0; // fade-in from silence on fresh loads too
        }
        el.dataset.trackId = track.id;
        fullUrl = url;
        const wantPreview = st.instantPreview && track.title && track.artist?.name;
        if (wantPreview) {
          // race: preview plays instantly, full MP3 swaps in when ready
          playMode = 'preview';
          el.src = api.tidalPreview(track.title, track.artist.name);
          bgAudio = new Audio();
          bgAudio.preload = 'auto';
          bgAudio.src = url;
          bgAudio.addEventListener('canplaythrough', trySwapToFull);
          bgAudio.addEventListener('progress', trySwapToFull);
          try { bgAudio.load(); } catch { /* noop */ }
        } else {
          playMode = 'full';
          el.src = url;
        }
        safeCurrentTime(el, 0);
        syncPlayback();
        if (st.crossfade && !st.muted) fadeVolume(el, st.volume, 600);
        else el.volume = st.muted ? 0 : st.volume;
        try { el.playbackRate = st.playbackRate || 1; } catch { /* noop */ }
      }
      // hot-standby prefetch: next track fully staged, the one after warming
      try { refreshUpcoming(); } catch { /* noop */ }
      // similar songs for current track (also pre-warmed so they start instantly)
      if (track.title) {
        api.similar(track.title, track.artist?.name || '', 8).then(j => {
          if (cancelled) return;
          const songs = j?.songs || [];
          useStore.getState().setSimilar(songs);
          songs.slice(0, 4).forEach(t => { try { if (t.streamUrl) api.warm(streamFor(t, quality)); } catch { /* noop */ } });
        }).catch(() => { if (!cancelled) useStore.getState().setSimilar([]); });
      } else useStore.getState().setSimilar([]);
      // media session
      if ('mediaSession' in navigator && track) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title, artist: track.artist?.name || '', album: track.album?.name || '',
            artwork: [96, 128, 192, 256, 512].map(sz => ({ src: track.image || '', sizes: `${sz}x${sz}` })),
          });
          const s = useStore.getState();
          navigator.mediaSession.setActionHandler('play', () => useStore.getState().setPlaying(true));
          navigator.mediaSession.setActionHandler('pause', () => useStore.getState().setPlaying(false));
          navigator.mediaSession.setActionHandler('previoustrack', () => s.prev());
          navigator.mediaSession.setActionHandler('nexttrack', () => s.next());
          try { navigator.mediaSession.setActionHandler('seekto', d => { if (typeof d.seekTime === 'number') seekTo(d.seekTime); }); } catch { /* noop */ }
          try { navigator.mediaSession.setActionHandler('stop', () => useStore.getState().setPlaying(false)); } catch { /* noop */ }
        } catch { /* noop */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  // re-stage upcoming tracks whenever the queue around us shifts
  // (reorder, add-to-queue, repeat/shuffle/quality toggles) — key-guarded, cheap
  const n1id = queue[index + 1]?.id;
  const n2id = queue[index + 2]?.id;
  useEffect(() => {
    try { refreshUpcoming(); } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, n1id, n2id, quality, repeat, shuffle, queue.length]);

  // Studio toggle: recreate element (routing is permanent), keep position + mode
  useEffect(() => {
    const el = getAudio();
    if (!track || !el.src) return;
    const st = useStore.getState();
    const direct = playMode === 'preview' ? el.src : (streamFor(track, st.quality) || '');
    if (!direct) return;
    const t = el.currentTime || 0;
    const wasPlaying = !el.paused;
    const nel = recreateAudio();
    nel.dataset.trackId = track.id;
    nel.src = direct;
    if (studioOn) {
      try {
        studio.ensureGraph(nel);
        studio.syncFromState({ gains: st.eqGains, preamp: st.eqPreamp, enabled: st.eqEnabled, normalize: st.normalizeOn });
        studio.resume();
      } catch { /* plain fallback */ }
    }
    const applyTime = () => { try { nel.currentTime = t; } catch { /* noop */ } };
    if (nel.readyState >= 1) applyTime();
    else nel.addEventListener('loadedmetadata', applyTime, { once: true });
    if (wasPlaying) syncPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioOn]);

  // play/pause — the single owner of playback decisions
  useEffect(() => {
    if (!track) return;
    studio.resume();
    syncPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, track?.id]);

  // volume
  useEffect(() => {
    const el = getAudio();
    el.volume = volume;
    el.muted = muted;
  }, [volume, muted]);

  // playback speed (pitch-preserving by default)
  useEffect(() => {
    try { getAudio().playbackRate = playbackRate || 1; } catch { /* noop */ }
  }, [playbackRate]);

  // seek requests
  const lastSeek = useRef(-1);
  useEffect(() => {
    const el = getAudio();
    if (lastSeek.current !== currentTime && Math.abs(el.currentTime - currentTime) > 1.5 && document.activeElement?.dataset?.seeking === '1') {
      el.currentTime = currentTime;
    }
    lastSeek.current = currentTime;
  }, [currentTime]);

  // sleep timer: deadline checked on every audio tick + backup watchers
  // (plain setTimeout freezes in background tabs — timestamps don't lie)
  useEffect(() => {
    sleepTimerEndsAt = sleepTimerMin > 0 ? Date.now() + sleepTimerMin * 60 * 1000 : 0;
  }, [sleepTimerMin]);
  useEffect(() => {
    const check = () => { if (sleepTimerEndsAt && Date.now() >= sleepTimerEndsAt) { sleepTimerEndsAt = 0; fireSleepTimer(); } };
    const iv = setInterval(check, 20000);
    const onVis = () => check();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); };
  }, []);

  // stall watchdog: playback should move the audio clock — if nothing arrives for
  // 12s (dead socket, captive portal), reload the stream; after 3 failed
  // recoveries in a row, skip the track instead of hanging forever
  useEffect(() => {
    const iv = setInterval(() => {
      try {
        const st = useStore.getState();
        if (!st.isPlaying) { recoverCount = 0; return; }
        const el = getAudio();
        if (!el.src || el.ended) return;
        if (Date.now() - lastProgressAt < 12000) return;
        if (Date.now() - lastRecoverAt < 30000) return;
        lastRecoverAt = Date.now();
        recoverCount += 1;
        try { diag.stalls++; } catch { /* noop */ }
        if (recoverCount >= 3) {
          recoverCount = 0;
          try { diag.skips++; } catch { /* noop */ }
          st.toast('Stream stalled — skipping to next', 'error');
          st.next();
          return;
        }
        st.toast('Connection stalled — recovering', 'info');
        try { el.load(); } catch { /* noop */ }
        lastProgressAt = Date.now();
        syncPlayback();
      } catch { /* noop */ }
    }, 8000);
    const onOnline = () => {
      try {
        const st = useStore.getState();
        const el = getAudio();
        if (st.isPlaying && el.src && el.paused && !el.ended) syncPlayback();
      } catch { /* noop */ }
    };
    window.addEventListener('online', onOnline);
    return () => { clearInterval(iv); window.removeEventListener('online', onOnline); };
  }, []);

  return { track };
}

export function seekTo(t) {
  const el = getAudio();
  if (!el.src) return;
  safeCurrentTime(el, t);
  useStore.getState().setTime(t, el.duration || useStore.getState().duration);
}
