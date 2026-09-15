import { Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useStore } from './store/useStore';
import { useAudioEngine } from './hooks/useAudioEngine';
import { Sidebar, TopBar, BottomNav, Toasts } from './components/Layout';
import { MiniPlayer, FullPlayer, QueueDrawer } from './components/Player';
import CommandPalette from './components/CommandPalette';
import Home from './pages/Home';
import Search from './pages/Search';
import Library, { LikedSongs, LocalPlaylist } from './pages/Library';
import { AlbumPage, ArtistPage, ExtPlaylistPage, ChartsPage } from './pages/Detail';
import Radio from './pages/Radio';
import Podcasts from './pages/Podcasts';
import Settings from './pages/Settings';

export default function App() {
  const theme = useStore(s => s.theme);
  useAudioEngine();

  useEffect(() => {
    window.__SOUNDWAVE_MOUNTED = true;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#121212' : '#f6f6f4');
  }, [theme]);

  const queue = useStore(s => s.queue);
  const index = useStore(s => s.index);
  const hasPlayer = index >= 0 && queue.length > 0;

  return (
    <div className="h-full flex bg-app">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col h-full">
        <TopBar />
        <main className={`flex-1 overflow-y-auto px-4 md:px-6 py-4 ${hasPlayer ? 'pb-36 md:pb-28' : 'pb-24 md:pb-8'}`} id="main">
          <div className="max-w-6xl mx-auto">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/search" element={<Search />} />
              <Route path="/charts" element={<ChartsPage />} />
              <Route path="/radio" element={<Radio />} />
              <Route path="/podcasts" element={<Podcasts />} />
              <Route path="/library" element={<Library />} />
              <Route path="/liked" element={<LikedSongs />} />
              <Route path="/playlist/:id" element={<LocalPlaylist />} />
              <Route path="/album/:source/:id" element={<AlbumPage />} />
              <Route path="/artist/:source/:id" element={<ArtistPage />} />
              <Route path="/ext-playlist/:source/:id" element={<ExtPlaylistPage />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </main>
      </div>
      <BottomNav />
      <MiniPlayer />
      <FullPlayer />
      <QueueDrawer />
      <CommandPalette />
      <Toasts />
    </div>
  );
}
