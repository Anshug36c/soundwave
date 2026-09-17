// Bridge between the web player and Android's media session.
//
// `window.SoundwaveMedia` is injected by the APK's WebView and does not exist in
// a browser, so every call is guarded and this module is a no-op elsewhere — the
// same build works on the web, in Termux, and in the APK.
//
// Direction of travel:
//   store  -> SoundwaveMedia.setState/setArtwork  -> notification, lock screen
//   notification buttons -> window.__swMedia.*    -> the same store actions the
//                                                   on-screen buttons use
//
// There is deliberately one source of truth: the store. Android never holds
// playback state of its own, so the two can't drift apart.

const bridge = typeof window !== 'undefined' ? window.SoundwaveMedia : null;

export function isNativeMedia() {
  return !!bridge;
}

/** Scale artwork down before base64-ing it; the notification never needs more. */
function artworkToDataUrl(img, max = 300) {
  try {
    if (!img || !img.complete || !img.naturalWidth) return null;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    // Throws SecurityError if the image is cross-origin without CORS headers.
    // Caught by the caller, which then shows the notification without artwork.
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
}

function findArtwork() {
  // The player bar renders the current track's artwork; fall back to any album
  // image on the page rather than showing nothing.
  const candidates = document.querySelectorAll(
    '.sp-playerbar img, [data-current-art] img, img[alt]',
  );
  for (const img of candidates) {
    if (img.naturalWidth >= 64) return img;
  }
  return null;
}

let lastArtKey = null;

function pushArtwork(track) {
  const img = findArtwork();
  const url = img?.currentSrc || img?.src || null;
  const key = `${track?.id || ''}|${url || ''}`;
  if (!url || key === lastArtKey) return;
  const data = artworkToDataUrl(img);
  if (!data) return;
  lastArtKey = key;
  try { bridge.setArtwork(data); } catch { /* non-fatal */ }
}

/**
 * Reports the store to Android. Called on every meaningful state change plus a
 * slow heartbeat; PlaybackState carries speed 1.0, so Android interpolates the
 * position between reports and the notification stays smooth without a tick per
 * second.
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
 * Receives transport commands from the notification and lock screen.
 * Returns an unsubscribe function.
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
