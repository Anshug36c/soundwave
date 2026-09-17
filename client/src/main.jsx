import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { useStore } from './store/useStore';
import { bindAndroidControls, reportToAndroid, isNativeMedia } from './services/androidMedia';
import './index.css';

// Notification-panel and lock-screen controls. No-op outside the APK, where
// window.SoundwaveMedia is not injected.
if (isNativeMedia()) {
  bindAndroidControls({
    // play(true) / play(false) are explicit so a notification button never
    // toggles the opposite of what its icon promised.
    togglePlay: (wantPlay) => {
      const s = useStore.getState();
      if (s.isPlaying !== wantPlay) s.togglePlay();
    },
    next: () => useStore.getState().next(),
    prev: () => useStore.getState().prev(),
    seekTo: (t) => useStore.getState()._seekTo?.(t),
    stop: () => useStore.setState({ isPlaying: false }),
  });

  // The store fires on every timeupdate (~4/s), and each report crosses the
  // JavaScript bridge, so only push when something the notification shows has
  // actually changed. Position is deliberately excluded: PlaybackState carries
  // speed 1.0, so Android interpolates it between reports.
  let lastKey = '';
  const push = () => {
    const s = useStore.getState();
    const track = s.queue?.[s.index];
    const key = `${track?.id || ''}|${s.isPlaying ? 1 : 0}|${Math.round(s.duration || 0)}`;
    if (key === lastKey) return;
    lastKey = key;
    reportToAndroid(s);
  };
  useStore.subscribe(push);
  // Heartbeat: catches artwork that had not finished loading on the first pass,
  // and corrects any position drift.
  setInterval(() => reportToAndroid(useStore.getState()), 5000);
  push();
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

// PWA: register service worker
if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname.endsWith('.e2b.app'))) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
