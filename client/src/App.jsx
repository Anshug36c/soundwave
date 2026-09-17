import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useEffect, lazy, Suspense } from 'react';
import { useStore } from './store/useStore';
import { useAudioEngine } from './hooks/useAudioEngine';
import { api } from './services/musicApi';
import { Sidebar, TopBar, BottomNav, Toasts, OfflineBanner } from './components/Layout';
import { MiniPlayer, FullPlayer, QueueDrawer } from './components/Player';
import PartyPanel from './components/Party';
import CommandPalette from './components/CommandPalette';
const Home = lazy(() => import('./pages/Home'));
const Search = lazy(() => import('./pages/Search'));
const Library = lazy(() => import('./pages/Library'));
const LikedSongs = lazy(() => import('./pages/Library').then(m => ({ default: m.LikedSongs })));
const LocalPlaylist = lazy(() => import('./pages/Library').then(m => ({ default: m.LocalPlaylist })));
const AlbumPage = lazy(() => import('./pages/Detail').then(m => ({ default: m.AlbumPage })));
const ArtistPage = lazy(() => import('./pages/Detail').then(m => ({ default: m.ArtistPage })));
const Settings = lazy(() => import('./pages/Settings'));

export default function App() {
  const theme = useStore(s => s.theme);
  useAudioEngine();

  const location = useLocation();
  useEffect(() => {
    window.__SOUNDWAVE_MOUNTED = true;
    if (theme !== 'dark' && theme !== 'light') { useStore.getState().setTheme('dark'); return; }
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#121212' : '#f6f6f4');
  }, [theme]);

  const queue = useStore(s => s.queue);
  const index = useStore(s => s.index);
  const hasPlayer = index >= 0 && queue.length > 0;

  // restore Google session after persist rehydration (account snapshots line up)
  useEffect(() => {
    const boot = () => {
      // /me is always 200; network failure = stay on the live store (offline-safe)
      api.auth.me().then(({ user }) => useStore.getState().reconcileSession(user)).catch(() => {});
    };
    if (useStore.persist.hasHydrated()) boot();
    else useStore.persist.onFinishHydration(boot);
  }, []);

  // route titles (the engine owns document.title while music is playing)
  useEffect(() => {
    const st = useStore.getState();
    if (st.queue.length && st.index >= 0) return;
    const p = location.pathname;
    const t = p.startsWith('/search') ? 'Search' : p.startsWith('/liked') ? 'Liked Songs'
      : p.startsWith('/playlist') ? 'Playlist' : p.startsWith('/library') ? 'Library'
      : p.startsWith('/album') ? 'Album' : p.startsWith('/artist') ? 'Artist'
      : p.startsWith('/settings') ? 'Settings' : '';
    document.title = t ? `${t} \u00b7 SoundWave` : 'SoundWave \u2014 Music for Everyone';
  }, [location.pathname]);

  return (
    <div className="h-full flex bg-app">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:m-2 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-accent focus:text-black focus:font-bold focus:text-sm">Skip to content</a>
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col h-full">
        <TopBar />
        <OfflineBanner />
        <main className={`flex-1 overflow-y-auto px-4 md:px-6 py-4 ${hasPlayer ? 'pb-40 md:pb-28' : 'pb-24 md:pb-8'}`} id="main">
          <div key={location.pathname} className="max-w-6xl mx-auto fade-up">
            <Suspense fallback={<div className="py-8"><div className="skeleton h-40 rounded-xl" /></div>}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/search" element={<Search />} />
              <Route path="/library" element={<Library />} />
              <Route path="/liked" element={<LikedSongs />} />
              <Route path="/playlist/:id" element={<LocalPlaylist />} />
              <Route path="/album/:source/:id" element={<AlbumPage />} />
              <Route path="/artist/all/:name" element={<ArtistPage />} />
              <Route path="/artist/:source/:id" element={<ArtistPage />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
          </div>
        </main>
      </div>
      <BottomNav hasPlayer={hasPlayer} />
      <MiniPlayer />
      <FullPlayer />
      <QueueDrawer />
      <PartyPanel />
      <CommandPalette />
      <Toasts />
    </div>
  );
}
