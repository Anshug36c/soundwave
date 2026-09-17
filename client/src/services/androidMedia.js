// Bridge between the web player and Android's media session.
//
// `window.SoundwaveMedia` is injected by the APK's WebView and does not exist in
// a browser, so every call is guarded and this module is a no-op elsewhere — the
// same build works on the web, in Termux, and in the APK.
//
// Direction of travel:
//   store  -> SoundwaveMedia.setState/setArtworkUrl  -> notification, lock screen
//   notification buttons -> window.__swMedia.*       -> the same store actions the
//                                                       on-screen buttons use
//
// There is deliberately one source of truth: the store. Android never holds
// playback state of its own, so the two can't drift apart.

const bridge = typeof window !== 'undefined' ? window.SoundwaveMedia : null;

export function isNativeMedia() {
  return !!bridge;
}

/**
 * Album art is passed to Android as a URL, not as pixels.
 *
 * The obvious approach — draw the <img> to a canvas and export a data URL —
 * silently fails for some providers: album art comes from several CDNs and at
 * least one sends no CORS header, which taints the canvas and makes toDataURL
 * throw. Android has no CORS, so handing it the URL works for every provider.
 */
function findArtworkUrl(track) {
  if (track?.image) return track.image;
  const img = document.querySelector('.sp-playerbar img, [data-current-art] img');
  return img?.currentSrc || img?.src || null;
}

let lastArtUrl = null;

function pushArtwork(track) {
  const url = findArtworkUrl(track);
  if (!url || url === lastArtUrl) return;
  lastArtUrl = url;
  try { bridge.setArtworkUrl(url); } catch { /* non-fatal */ }
}

/**
 * Reports the store to Android.
 *
 * Called only when something the notification actually displays has changed.
 * Position is deliberately excluded: PlaybackState carries speed 1.0, so Android
 * interpolates it between reports and the progress stays smooth without this
 * crossing the bridge several times a second.
 */
export function reportToAndroid(state) {
  if (!bridge) return;
  const track = state.queue?.[state.index];
  try {
    bridge.setState(JSON.stringify({
      hasTrack: !!track,
      title: track?.title || '',
      artist: track?.artist?.name || '',
      album: track?.album?.name || '',
      durationMs: Math.round((state.duration || 0) * 1000),
      positionMs: Math.round((state.currentTime || 0) * 1000),
      playing: !!state.isPlaying,
    }));
  } catch { /* a broken bridge must never break playback */ }
  if (track) pushArtwork(track);
}

/**
 * Receives transport commands from the notification, lock screen and headset
 * buttons. Returns an unsubscribe function.
 */
export function bindAndroidControls({ togglePlay, next, prev, seekTo, stop }) {
  if (typeof window === 'undefined') return () => {};
  const handler = {
    play: () => togglePlay(true),
    pause: () => togglePlay(false),
    next: () => next(),
    prev: () => prev(),
    stop: () => stop(),
    seek: (ms) => { if (Number.isFinite(ms)) seekTo(ms / 1000); },
  };
  window.__swMedia = handler;
  return () => { if (window.__swMedia === handler) delete window.__swMedia; };
}
