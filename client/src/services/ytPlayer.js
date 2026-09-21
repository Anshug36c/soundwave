// YouTube playback through the official IFrame Player.
//
// WHY AN EMBED AND NOT A STREAM URL
// ---------------------------------
// YouTube no longer hands fetchable stream URLs to a plain server: the
// /player endpoint answers UNPLAYABLE with zero formats on every client, and
// the player response embedded in the watch page lists formats with metadata
// only — no `url`, no `signatureCipher`. The APK cannot run yt-dlp either; it
// bundles a Node runtime and nothing else. So the one path that actually
// plays a YouTube video on the phone is YouTube's own player, embedded.
//
// The iframe is always parked off-screen. The app exposes YouTube as an audio
// source only; the official player remains the reliable playback mechanism.
//
// "Play as mp3" is therefore audio-only playback, not an mp3 file: there is no
// audio data here to hand to a downloader, and no way to route it through the
// equaliser, because the Web Audio API cannot tap an iframe.

const OFFSCREEN = {
  position: 'fixed', left: '0px', top: '0px', width: '2px', height: '2px',
  opacity: '0.01', pointerEvents: 'none', zIndex: '-1', overflow: 'hidden',
};

let apiPromise = null;
let player = null;
let playerReady = false;
let container = null;     // the div we create; the API replaces it with an iframe
let iframe = null;        // the actual element to position, from player.getIframe()
let pollTimer = null;
let volume = 90;
let muted = false;
let activeVideoId = '';
let loadWaiter = null;

function settleLoad(ok) {
  if (!loadWaiter) return;
  const waiter = loadWaiter;
  loadWaiter = null;
  clearTimeout(waiter.timer);
  waiter.resolve(ok);
}

const listeners = new Set();
function emit(event, data) {
  for (const fn of listeners) { try { fn(event, data); } catch { /* a bad listener must not break playback */ } }
}

/** Subscribe to player events. Returns an unsubscribe function. */
export function onYouTubeEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Loads the IFrame API script once. Resolves with window.YT. */
export function ensureYouTubeApi() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const settle = (fn, arg) => { clearTimeout(timer); fn(arg); };
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try { prev?.(); } catch { /* not ours */ }
      settle(resolve, window.YT);
    };
    const timer = setTimeout(() => {
      apiPromise = null;
      reject(new Error('YouTube player did not load'));
    }, 15000);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => { apiPromise = null; settle(reject, new Error('YouTube player blocked')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

/** Returns the actual iframe created by the YouTube API. */
function surface() {
  if (!iframe) { try { iframe = player?.getIframe?.() || null; } catch { iframe = null; } }
  return iframe || container;
}

function makeContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.id = 'sw-yt-player';
  container.setAttribute('aria-hidden', 'true');
  Object.assign(container.style, OFFSCREEN);
  document.body.appendChild(container);
  return container;
}

/**
 * Creates the player once and resolves when it is ready to take commands.
 * The IFrame API replaces the container div with an iframe, so the container
 * must exist before this runs.
 */
let createPromise = null;
function createPlayer() {
  if (createPromise) return createPromise;
  createPromise = new Promise((resolve) => {
    const YT = window.YT;
    player = new YT.Player(makeContainer(), {
      width: '100%',
      height: '100%',
      // controls/fs/disablekb off: the app draws its own transport, so
      // YouTube's chrome would be a second set of controls that can disagree
      // with ours.
      playerVars: {
        playsinline: 1, rel: 0, modestbranding: 1, controls: 0,
        iv_load_policy: 3, disablekb: 1, fs: 0,
      },
      events: {
        onReady: () => {
          playerReady = true;
          try { iframe = player.getIframe(); } catch { iframe = null; }
          Object.assign(surface()?.style || {}, OFFSCREEN);
          try { player.setVolume(volume); } catch { /* noop */ }
          if (muted) { try { player.mute(); } catch { /* noop */ } }
          resolve(true);
          emit('ready');
        },
        onStateChange: (e) => {
          const S = window.YT.PlayerState;
          if (e.data === S.PLAYING || e.data === S.CUED) settleLoad(true);
          if (e.data === S.PLAYING) { emit('playing'); startPoll(); }
          else if (e.data === S.PAUSED) { emit('paused'); stopPoll(); }
          else if (e.data === S.ENDED) { emit('ended'); stopPoll(); }
          else if (e.data === S.BUFFERING) emit('buffering');
          else if (e.data === S.CUED) emit('cued');
        },
        onError: (e) => {
          stopPoll();
          settleLoad(false);
          // 2 = invalid id, 5 = HTML5 error, 100 = missing, 101/150 = embedding disabled.
          emit('error', { code: Number(e.data), videoId: activeVideoId });
        },
      },
    });
    // A player that never fires onReady would wedge every YouTube track.
    setTimeout(() => {
      if (!playerReady) {
        createPromise = null;
        try { player?.destroy?.(); } catch { /* player may not have a DOM node yet */ }
        player = null;
        iframe = null;
        container = null;
        resolve(false);
      }
    }, 15000);
  });
  return createPromise;
}

// The time poll is what drives the progress bar and the notification's
// position. The IFrame API has no timeupdate event, so it is polled, but only
// while something is actually playing.
function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!player || !playerReady) return;
    let cur = 0, dur = 0;
    try { cur = player.getCurrentTime() || 0; dur = player.getDuration() || 0; } catch { return; }
    emit('time', { current: cur, duration: dur });
  }, 500);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/**
 * Loads a video. `autoplay` false only cues it, so the app stays in control of
 * when sound starts (autoplay policies reject play() without a gesture).
 */
export async function youTubeLoad(videoId, { start = 0, autoplay = true } = {}) {
  const id = String(videoId || '');
  if (!id) return false;
  await ensureYouTubeApi();
  const ok = await createPlayer();
  if (!ok || !playerReady || !player) return false;
  settleLoad(false);
  activeVideoId = id;
  try { player.stopVideo(); } catch { /* release the previous video's decoder */ }
  try { player.setVolume(volume); } catch { /* noop */ }
  const started = new Promise(resolve => {
    const timer = setTimeout(() => {
      if (loadWaiter?.id === id) {
        loadWaiter = null;
        resolve(false);
      }
    }, 12000);
    loadWaiter = { id, resolve, timer };
  });
  try {
    const args = { videoId: id, startSeconds: Math.max(0, start) };
    if (autoplay) player.loadVideoById(args);
    else player.cueVideoById(args);
  } catch (e) {
    settleLoad(false);
    return false;
  }
  return started;
}

export function youTubePlay() { try { player?.playVideo(); } catch { /* noop */ } }
export function youTubePause() { try { player?.pauseVideo(); } catch { /* noop */ } }
export function youTubeSeek(seconds) { try { player?.seekTo(Math.max(0, seconds), true); } catch { /* noop */ } }

export function youTubeSetVolume(v01) {
  volume = Math.round(Math.min(1, Math.max(0, v01)) * 100);
  try { player?.setVolume(volume); } catch { /* noop */ }
}

export function youTubeSetMuted(isMuted) {
  muted = !!isMuted;
  try { if (muted) player?.mute(); else player?.unMute(); } catch { /* noop */ }
}

/** Stops and releases the player — used when the app tears playback down. */
export function youTubeStop() {
  stopPoll();
  settleLoad(false);
  activeVideoId = '';
  try { player?.stopVideo(); } catch { /* noop */ }
}
