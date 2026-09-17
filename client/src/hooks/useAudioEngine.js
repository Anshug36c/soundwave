import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { api, streamFor, diag, diagEvent } from '../services/musicApi';

// structured dev tracing: set localStorage soundwave-debug=1 — silent otherwise
function dbg(...a) {
  try { if (localStorage.getItem('soundwave-debug') === '1') console.debug('[audio]', ...a); } catch { /* noop */ }
}

// refresh-during-playback: resume position (same-tab session only, consumed once)
const POS_KEY = 'soundwave-pos-v1';
let pendingSeek = null;
try { pendingSeek = JSON.parse(sessionStorage.getItem(POS_KEY) || 'null'); } catch { /* noop */ }
let lastPosSave = 0;
let switchAt = 0, pendingSwitch = false;
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
// Assigning el.src implicitly pauses the element (browser fires 'pause' with
// timing we can't control). Tag every programmatic src swap so onPause can
// tell OUR swap-settling apart from genuine user/OS pauses. Safe: every real
// pause path (togglePlay, media keys, sleep timer) sets the store FIRST.
let lastSrcAssign = 0;
function markSrcAssign() { lastSrcAssign = Date.now(); }
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
// drop every pooled preload (track/queue change made them obsolete); the
// survivors are re-staged by refreshUpcoming immediately after
function purgePreloads() {
  while (preloadPool.length) {
    const old = preloadPool.shift();
    try { old.removeAttribute('src'); old.load(); } catch { /* noop */ }
  }
}
// ---------- hot standby: next track staged to canplaythrough BEFORE current ends ----------
// queue advances then cut instantly (no fade-out stall, no src-set buffering gap)
let standbyAudio = null, standbyFor = '', standbyQ = '', standbyReady = false, standbyTimer = 0;
let standbySettledFor = '', upcomingKey = '';
function teardownStandby() {
  if (standbyAudio) {
    try { standbyAudio.removeAttribute('src'); standbyAudio.load(); } catch { /* noop */ }
    standbyAudio = null;
  }
  if (standbyTimer) { clearTimeout(standbyTimer); standbyTimer = 0; }
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
  dbg('standby arm', id);
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
    if (standbyTimer) clearTimeout(standbyTimer);
    standbyTimer = setTimeout(() => { standbyTimer = 0; if (standbyFor === id) settleStandby(id); }, 30000); // never stall n2 past 30s
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
  dbg('preview→full swap at', Math.round(t), 's');
  playMode = 'full';
  markSrcAssign();
  el.src = fullUrl;
  if (useStore.getState().isPlaying) useStore.getState().setBuffering(true); // swap gap shows the spinner
  // currentTime must be set AFTER metadata is ready, else the track restarts at 0.
  // Token-guarded: if the user skipped while metadata was in flight, the stale
  // seek must not yank the NEW track back to the old position.
  const tid = el.dataset.trackId;
  // ALWAYS wait for the new resource's metadata: readyState sampled right after
  // a src set still describes the OLD resource, so a sync seek is silently lost.
  el.addEventListener('loadedmetadata', () => {
    if (getAudio().dataset.trackId !== tid) return;
    // max-preserving: the boot-resume listener (attached earlier, same element)
    // fires first on this metadata when the swap won the race against the tidal
    // metadata — never yank its applied position back to our pre-swap reading.
    // Normal swaps are unaffected (fresh resource reads ~0, so max() == t).
    try { el.currentTime = Math.max(t, el.currentTime || 0); } catch { /* noop */ }
    if (useStore.getState().isPlaying) syncPlayback(); // resume if the swap implicitly paused
  }, { once: true });
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
/** Smooth volume ramp (crossfade / sleep fade-out). Token-cancelled: rapid
 *  skips start a new fade that kills the old one instead of fighting it. */
let fadeToken = 0;
function cancelFade() { fadeToken++; }
function fadeVolume(el, to, ms) {
  return new Promise(resolve => {
    const tok = ++fadeToken;
    const from = el.volume;
    if (Math.abs(from - to) < 0.02 || ms <= 0) { el.volume = to; resolve(); return; }
    const steps = 14;
    let i = 0;
    const t = setInterval(() => {
      if (tok !== fadeToken) { clearInterval(t); resolve(); return; } // superseded
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
  // A-B section repeat: loop back to A when B is reached (never fights an active seek drag)
  try {
    const ab = st.abLoop;
    if (ab && ab.a != null && ab.b != null && st.isPlaying && el.duration) {
      const t = el.currentTime || 0;
      const dragging = document.activeElement?.dataset?.seeking === '1';
      if (!dragging && (t >= ab.b || t < ab.a - 0.25)) el.currentTime = ab.a;
    }
  } catch { /* noop */ }
  try {
    const now = Date.now();
    if (now - lastPosSave > 5000 && el.currentTime > 5 && st.index >= 0) {
      lastPosSave = now;
      const tid = st.queue[st.index]?.id;
      if (tid) sessionStorage.setItem(POS_KEY, JSON.stringify({ id: tid, t: Math.floor(el.currentTime) }));
    }
  } catch { /* noop */ }
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
  const st = useStore.getState();
  st.setPlaying(true);
  st.setBuffering(false);
  if (pendingSwitch) { pendingSwitch = false; try { diagEvent('switch', Date.now() - switchAt); } catch { /* noop */ } }
  try { navigator.mediaSession.playbackState = 'playing'; } catch { /* noop */ }
}
function onWaiting() {
  useStore.getState().setBuffering(true); // audible stall: spinner until data flows
}
function onCanPlay() {
  useStore.getState().setBuffering(false);
}
function onPause() {
  const el = getAudio();
  if (el.ended) return;
  if (el.readyState === 0) return; // mid-load noise
  if (Date.now() - lastSrcAssign < 800) return; // our own src swap settling
  useStore.getState().setPlaying(false);
  try { navigator.mediaSession.playbackState = 'paused'; } catch { /* noop */ }
}
let recentErrors = [];
function onError() {
  useStore.getState().setBuffering(false);
  // preview failed (no Tidal match etc.) — fall through to the full MP3
  if (playMode === 'preview' && fullUrl) {
    playMode = 'full';
    const el = getAudio();
    markSrcAssign();
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
  dbg('error', { mode: playMode, src: (() => { try { return getAudio().src.slice(0, 80); } catch { return ''; } })() });
  if (recentErrors.length >= 4) {
    recentErrors = [];
    s.setPlaying(false);
    pendingSwitch = false; // don't record a stale switch time on the next manual play
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
    markSrcAssign();
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
  else if (e.key.toLowerCase() === 'l') s.cycleLoopPoint(el.currentTime || 0);
}

function attachAudio(el) {
  el.addEventListener('timeupdate', onTime);
  el.addEventListener('loadedmetadata', onLoaded);
  el.addEventListener('play', onPlay);
  el.addEventListener('playing', onCanPlay);
  el.addEventListener('waiting', onWaiting);
  el.addEventListener('canplay', onCanPlay);
  el.addEventListener('pause', onPause);
  el.addEventListener('error', onError);
  el.addEventListener('ended', onEnded);
}
function detachAudio(el) {
  el.removeEventListener('timeupdate', onTime);
  el.removeEventListener('loadedmetadata', onLoaded);
  el.removeEventListener('play', onPlay);
  el.removeEventListener('playing', onCanPlay);
  el.removeEventListener('waiting', onWaiting);
  el.removeEventListener('canplay', onCanPlay);
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
  const gain = useStore(s => s.gain);
  const playbackRate = useStore(s => s.playbackRate);
  const quality = useStore(s => s.quality);
  const sleepTimerMin = useStore(s => s.sleepTimerMin);
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
        useStore.getState().setPlaying(false);
        useStore.getState().toast('No playable stream for this track', 'error');
        return;
      }
      const st = useStore.getState();
      try { document.title = `${track.title} — ${track.artist?.name || ''} · SoundWave`; } catch { /* noop */ }
      if (st.studioOn || st.gain > 1) {
        try {
          studio.ensureGraph(el);
          studio.syncFromState({ gains: st.eqGains, preamp: st.eqPreamp, enabled: st.eqEnabled, normalize: st.normalizeOn, gain: st.gain });
          studio.resume();
        } catch { /* plain fallback */ }
      }
      if (el.dataset.trackId !== track.id) {
        useStore.getState().clearLoop();
        const hot = standbyReady && standbyFor === track.id;
        switchAt = Date.now(); pendingSwitch = true;
        teardownStandby(); // staged n1 is now current: free its socket before el.src starts
        purgePreloads();   // queued skips obsolete every pool preload; rebuilt below
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
        dbg('load', track.id, hot ? 'hot' : 'cold', wantPreview ? 'preview' : 'full');
        if (wantPreview) {
          // race: preview plays instantly, full MP3 swaps in when ready
          playMode = 'preview';
          markSrcAssign();
          el.src = api.tidalPreview(track.title, track.artist.name);
          bgAudio = new Audio();
          bgAudio.preload = 'auto';
          bgAudio.src = url;
          bgAudio.addEventListener('canplaythrough', trySwapToFull);
          bgAudio.addEventListener('progress', trySwapToFull);
          try { bgAudio.load(); } catch { /* noop */ }
        } else {
          playMode = 'full';
          markSrcAssign();
          el.src = url;
        }
        if (pendingSeek && pendingSeek.id === track.id && pendingSeek.t >= 5) {
          // boot restore: resume where a refresh interrupted (same track, once)
          const rt = pendingSeek.t;
          pendingSeek = null;
          try { sessionStorage.removeItem(POS_KEY); } catch { /* noop */ }
          const tid = track.id;
          el.addEventListener('loadedmetadata', () => {
            if (getAudio().dataset.trackId !== tid) return;
            try { el.currentTime = rt; } catch { /* noop */ }
            try { useStore.getState().setTime(rt, el.duration || 0); } catch { /* noop */ } // bar shows resume point while paused
          }, { once: true });
          dbg('resume', track.id, `at ${rt}s`);
        } else {
          safeCurrentTime(el, 0);
        }
        if (useStore.getState().isPlaying) useStore.getState().setBuffering(true); // preparing…
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
          // P4 priority: similar-tracks warm waits 2.5s so n1/n2 own the
          // bandwidth first; cancelled outright if the track changed meanwhile
          setTimeout(() => {
            if (cancelled) return;
            try { if (!navigator.onLine || navigator.connection?.saveData) return; } catch { /* noop */ }
            songs.slice(0, 4).forEach(t => { try { if (t.streamUrl) api.warm(streamFor(t, quality)); } catch { /* noop */ } });
          }, 2500);
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
    try { purgePreloads(); refreshUpcoming(); } catch { /* noop */ } // queue shifted: obsolete pool first, then re-stage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, n1id, n2id, quality, repeat, shuffle, queue.length]);

  // Studio/boost toggle: recreate element when graph routing NEED flips
  // (routing is permanent), keep position + mode. Pure level changes while
  // already routed just push the master gain — no recreate, no glitch.
  // MOUNT MUST SKIP: with sync persist rehydration a track is already restored
  // (and the load effect above has already set el.src in this same commit), so
  // running here would recreateAudio() away the just-configured element and
  // orphan its resume listener. Mount-with-routing is already handled by the
  // load effect's ensureGraph call — this path is for toggles only.
  const firstStudio = useRef(true);
  useEffect(() => {
    if (firstStudio.current) { firstStudio.current = false; return; }
    const el = getAudio();
    if (!track || !el.src) return;
    const st = useStore.getState();
    const needGraph = studioOn || st.gain > 1;
    if (needGraph && studio.isRouted(el)) { studio.setMasterGain(st.gain); return; }
    if (!needGraph && !studio.isRouted(el)) return;
    const direct = playMode === 'preview' ? el.src : (streamFor(track, st.quality) || '');
    if (!direct) return;
    const t = el.currentTime || 0;
    const wasPlaying = !el.paused;
    const nel = recreateAudio();
    nel.dataset.trackId = track.id;
    markSrcAssign();
    nel.src = direct;
    if (needGraph) {
      try {
        studio.ensureGraph(nel);
        studio.syncFromState({ gains: st.eqGains, preamp: st.eqPreamp, enabled: st.eqEnabled, normalize: st.normalizeOn, gain: st.gain });
        studio.resume();
      } catch { /* plain fallback */ }
    }
    const tid = track.id;
    nel.addEventListener('loadedmetadata', () => { if (getAudio().dataset.trackId === tid) { try { nel.currentTime = t; } catch { /* noop */ } } }, { once: true });
    if (wasPlaying) syncPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioOn, gain]);

  // play/pause — the single owner of playback decisions
  useEffect(() => {
    if (!track) return;
    studio.resume();
    syncPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, track?.id]);

  // volume (cancels crossfade ramps — the user's hand wins)
  useEffect(() => {
    cancelFade();
    const el = getAudio();
    el.volume = volume;
    el.muted = muted;
  }, [volume, muted]);

  // quality change: rebuild the current stream at the new tier, keep position
  // (preview mode owns its own src — the flip to full picks the new tier up)
  const firstQuality = useRef(true);
  useEffect(() => {
    if (firstQuality.current) { firstQuality.current = false; return; }
    const el = getAudio();
    if (!track || !el.src || playMode === 'preview') return;
    const url = streamFor(track, quality);
    if (!url) return;
    const t = (pendingSeek?.id === track.id && pendingSeek.t >= 5) ? pendingSeek.t : (el.currentTime || 0);
    const wantPlay = useStore.getState().isPlaying; // store truth, not the element's mid-swap state
    const tid = track.id;
    markSrcAssign();
    el.src = url;
    dbg('quality switch →', quality);
    el.addEventListener('loadedmetadata', () => {
      if (getAudio().dataset.trackId !== tid) return;
      try { el.currentTime = t; } catch { /* noop */ }
      // deferred resume: the src swap implicitly pauses; re-issue play only
      // once the element has settled (early-returns if already playing)
      if (wantPlay) syncPlayback();
    }, { once: true });
    teardownStandby(); purgePreloads();
    try { refreshUpcoming(); } catch { /* noop */ } // re-stage n1/n2 at the new tier
    if (wantPlay) syncPlayback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quality]);

  // playback speed (pitch-preserving by default)
  useEffect(() => {
    try { getAudio().playbackRate = playbackRate || 1; } catch { /* noop */ }
  }, [playbackRate]);

  // seek requests — subscription-driven, zero re-renders. The engine is mounted
  // at app root, so subscribing to the 4Hz playback clock re-rendered the whole
  // tree on every tick. Same semantics as before, without the render churn.
  const lastSeek = useRef(-1);
  useEffect(() => {
    const apply = (ct) => {
      if (lastSeek.current === ct) return;
      const el = getAudio();
      if (Math.abs(el.currentTime - ct) > 1.5 && document.activeElement?.dataset?.seeking === '1') {
        try { el.currentTime = ct; } catch { /* metadata not ready mid-drag */ }
      }
      lastSeek.current = ct;
    };
    apply(useStore.getState().currentTime);
    return useStore.subscribe((s) => apply(s.currentTime));
  }, []);

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
          dbg('watchdog skip after 3 recoveries');
          st.next();
          return;
        }
        st.toast('Connection stalled — recovering', 'info');
        dbg('watchdog recover #', recoverCount);
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
