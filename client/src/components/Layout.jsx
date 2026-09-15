import { NavLink, Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useStore } from '../store/useStore';

const nav = [
  { to: '/', label: 'Home', icon: '🏠' },
  { to: '/search', label: 'Search', icon: '🔍' },
  { to: '/charts', label: 'Charts', icon: '📈' },
  { to: '/radio', label: 'Radio', icon: '📻' },
  { to: '/podcasts', label: 'Podcasts', icon: '🎙️' },
  { to: '/library', label: 'Your Library', icon: '📚' },
  { to: '/liked', label: 'Liked Songs', icon: '❤️' },
];

export function GhostLogo({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2C7.2 2 3.5 5.8 3.5 10.6v7.9l2.4-1.9 2 1.9 2.5-1.9 2 1.9 2.5-1.9 2 1.9 2.4-1.9v-7.9C20.5 5.8 16.8 2 12 2z" fill="#fff" stroke="#141414" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="9" cy="10.5" r="1.3" fill="#141414" />
      <circle cx="15" cy="10.5" r="1.3" fill="#141414" />
    </svg>
  );
}

export function Sidebar() {
  const playlists = useStore(s => s.playlists);
  const createPlaylist = useStore(s => s.createPlaylist);
  const toast = useStore(s => s.toast);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  return (
    <aside className="hidden md:flex w-64 shrink-0 flex-col gap-2 p-2 h-full">
      <div className="card p-4">
        <Link to="/" className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
          <span className="w-9 h-9 rounded-2xl bg-accent grid place-items-center shrink-0"><GhostLogo size={26} /></span>
          SoundWave
        </Link>
        <nav className="mt-4 flex flex-col gap-1" aria-label="Primary">
          {nav.slice(0, 3).map(n => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => `px-3 py-2 rounded-lg font-semibold text-sm ${isActive ? 'bg-accent text-black' : 'text-dim hover:text-white bg-hoverable'}`}>
              <span className="mr-2">{n.icon}</span>{n.label}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="card p-4 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between">
          <span className="font-bold text-sm text-dim">PLAYLISTS</span>
          <button onClick={() => setCreating(v => !v)} className="text-xl leading-none px-2 rounded bg-hoverable" aria-label="Create playlist">＋</button>
        </div>
        {creating && (
          <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; createPlaylist(name.trim()); setName(''); setCreating(false); toast('Playlist created'); }}>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Playlist name" className="w-full bg-soft border border-soft rounded-lg px-2 py-1.5 text-sm outline-none" />
            <button className="btn-accent px-3 text-sm">Add</button>
          </form>
        )}
        <nav className="mt-3 flex flex-col gap-1" aria-label="Library">
          <NavLink to="/library" className={({ isActive }) => `px-3 py-2 rounded-lg text-sm font-semibold ${isActive ? 'bg-accent text-black' : 'text-dim hover:text-white bg-hoverable'}`}>📚 Your Library</NavLink>
          <NavLink to="/liked" className={({ isActive }) => `px-3 py-2 rounded-lg text-sm font-semibold ${isActive ? 'bg-accent text-black' : 'text-dim hover:text-white bg-hoverable'}`}>❤️ Liked Songs</NavLink>
        </nav>
        <div className="mt-3 flex flex-col gap-1">
          {playlists.map(p => (
            <NavLink key={p.id} to={`/playlist/${encodeURIComponent(p.id)}`} className="px-3 py-2 rounded-lg text-sm text-dim hover:text-white bg-hoverable truncate">
              🎵 {p.name} <span className="opacity-60">· {p.tracks.length}</span>
            </NavLink>
          ))}
          {playlists.length === 0 && <p className="text-xs text-dim px-3 py-2">No playlists yet — create one!</p>}
        </div>
      </div>
    </aside>
  );
}

export function TopBar() {
  const navigate = useNavigate();
  const profile = useStore(s => s.profile);
  const theme = useStore(s => s.theme);
  const setTheme = useStore(s => s.setTheme);
  const [q, setQ] = useState('');
  const cycleTheme = () => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'snap' : 'dark');
  const themeIcon = theme === 'dark' ? '☀️' : theme === 'light' ? '👻' : '🌙';

  return (
    <header className="sticky top-0 z-20 glass border-b border-soft">
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-full bg-hoverable grid place-items-center" aria-label="Go back">←</button>
        <button onClick={() => navigate(1)} className="w-9 h-9 rounded-full bg-hoverable grid place-items-center hidden sm:grid" aria-label="Go forward">→</button>
        <form className="flex-1 max-w-xl" onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`); }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search songs, artists, albums…" aria-label="Search"
            className="w-full bg-soft border border-soft rounded-full px-4 py-2 text-sm outline-none focus:border-green-500" />
        </form>
        <button onClick={() => window.dispatchEvent(new Event('soundwave:palette'))} className="h-9 px-3 rounded-full bg-hoverable grid place-items-center text-sm font-bold" aria-label="Command palette" title="Command palette (Ctrl+K)">⌘K</button>
        <button onClick={cycleTheme} className="w-9 h-9 rounded-full bg-hoverable grid place-items-center" aria-label="Cycle theme" title={`Theme: ${theme} (click to change)`}>
          {themeIcon}
        </button>
        <Link to="/settings" className="w-9 h-9 rounded-full bg-accent grid place-items-center font-bold text-black" aria-label="Profile and settings" title={profile.name}>
          {(profile.name?.[0] || 'G').toUpperCase()}
        </Link>
      </div>
    </header>
  );
}

export function BottomNav() {
  return (
    <nav className="md:hidden fixed bottom-[64px] left-0 right-0 z-20 glass border-t border-soft flex justify-around py-2" aria-label="Mobile">
      {nav.map(n => (
        <NavLink key={n.to} to={n.to} className={({ isActive }) => `flex flex-col items-center text-[11px] font-semibold px-3 ${isActive ? 'accent' : 'text-dim'}`}>
          <span className="text-lg">{n.icon}</span>{n.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function Toasts() {
  const toasts = useStore(s => s.toasts);
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 items-center pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className={`px-4 py-2 rounded-full text-sm font-semibold shadow-lg ${t.kind === 'error' ? 'bg-red-600 text-white' : 'bg-accent text-black'}`}>{t.msg}</div>
      ))}
    </div>
  );
}
