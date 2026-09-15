import { NavLink, Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useStore } from '../store/useStore';
import { HomeIcon, SearchIcon, LibraryIcon, PlusIcon, HeartIcon, NoteIcon, ChevronLeftIcon, ChevronRightIcon, MoonIcon, SunIcon, GhostIcon } from './Icons';

export function WaveLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" fill="#1db954" />
      <path d="M8 10.2c2.6-1.5 5.4-1.4 8-.2" stroke="#000" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M8.4 13c2.1-1.2 4.4-1.1 6.6-.2" stroke="#000" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M8.8 15.8c1.7-.9 3.5-.9 5.2-.2" stroke="#000" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

const mainNav = [
  { to: '/', label: 'Home', Icon: HomeIcon },
  { to: '/search', label: 'Search', Icon: SearchIcon },
  { to: '/library', label: 'Your Library', Icon: LibraryIcon },
];

export function Sidebar() {
  const liked = useStore(s => s.liked);
  const playlists = useStore(s => s.playlists);
  const createPlaylist = useStore(s => s.createPlaylist);
  const toast = useStore(s => s.toast);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const likedCount = Object.keys(liked).length;

  return (
    <aside className="hidden md:flex w-[288px] shrink-0 flex-col gap-2 p-2 h-full">
      <div className="panel px-3 py-5">
        <Link to="/" className="flex items-center gap-2.5 px-3 text-[22px] font-extrabold tracking-tight" style={{ color: 'var(--text)' }}>
          <WaveLogo size={36} /> SoundWave
        </Link>
        <nav className="mt-6 flex flex-col gap-1 px-1" aria-label="Primary">
          {mainNav.map(({ to, label, Icon }) => (
            <NavLink key={to} to={to}
              className={({ isActive }) => `flex items-center gap-4 px-2 py-2.5 text-[15px] font-bold transition-colors ${isActive ? '' : 'text-dim hover:text-white'}`}
              style={({ isActive }) => isActive ? { color: 'var(--text)' } : undefined}>
              {({ isActive }) => (<><Icon size={24} active={isActive} />{label}</>)}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="panel p-3 flex-1 overflow-y-auto min-h-0">
        <div className="flex items-center justify-between px-2 py-2">
          <span className="text-[15px] font-bold text-dim">Playlists</span>
          <button onClick={() => setCreating(v => !v)} className="p-1 rounded-full text-dim hover:text-white transition-colors" aria-label="Create playlist">
            <PlusIcon size={20} />
          </button>
        </div>
        {creating && (
          <form className="px-2 pb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; createPlaylist(name.trim()); setName(''); setCreating(false); toast('Playlist created'); }}>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Playlist name" className="w-full bg-soft border border-soft rounded-lg px-2 py-1.5 text-sm outline-none" />
            <button className="btn-accent px-3 text-sm shrink-0">Add</button>
          </form>
        )}
        <Link to="/liked" className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-white/5 transition-colors">
          <span className="w-12 h-12 rounded grid place-items-center shrink-0 bg-gradient-to-br from-indigo-600 via-purple-500 to-purple-300">
            <HeartIcon size={20} filled className="text-white" />
          </span>
          <span className="min-w-0">
            <span className="block text-[15px]" style={{ color: 'var(--text)' }}>Liked Songs</span>
            <span className="block text-[13px] text-dim">Playlist · {likedCount}</span>
          </span>
        </Link>
        {playlists.map(p => (
          <Link key={p.id} to={`/playlist/${encodeURIComponent(p.id)}`} className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-white/5 transition-colors">
            <span className="w-12 h-12 rounded grid place-items-center shrink-0 bg-white/10 text-dim"><NoteIcon size={20} /></span>
            <span className="min-w-0">
              <span className="block text-[15px] truncate" style={{ color: 'var(--text)' }}>{p.name}</span>
              <span className="block text-[13px] text-dim">Playlist · {p.tracks.length}</span>
            </span>
          </Link>
        ))}
        {playlists.length === 0 && <p className="text-xs text-dim px-3 py-2">No playlists yet — create one!</p>}
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

  return (
    <header className="sticky top-0 z-20 glass border-b border-soft">
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-full bg-black/50 grid place-items-center text-dim hover:text-white shrink-0" aria-label="Go back">
          <ChevronLeftIcon size={18} />
        </button>
        <button onClick={() => navigate(1)} className="w-9 h-9 rounded-full bg-black/50 place-items-center text-dim hover:text-white shrink-0 hidden sm:grid" aria-label="Go forward">
          <ChevronRightIcon size={18} />
        </button>
        <div className="flex-1 max-w-xl relative">
          <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`); }}>
            <SearchIcon size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-dim pointer-events-none" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="What do you want to listen to?" aria-label="Search"
              className="w-full bg-soft border border-soft rounded-full pl-10 pr-4 py-2 text-sm outline-none focus:border-green-500" />
          </form>
        </div>
        <button onClick={() => window.dispatchEvent(new Event('soundwave:palette'))} className="h-9 px-3 rounded-full bg-hoverable hidden sm:grid place-items-center text-sm font-bold shrink-0" aria-label="Command palette" title="Command palette (Ctrl+K)">⌘K</button>
        <button onClick={cycleTheme} className="w-9 h-9 rounded-full bg-hoverable grid place-items-center text-dim hover:text-white shrink-0" aria-label="Cycle theme" title={`Theme: ${theme} (click to change)`}>
          {theme === 'dark' ? <SunIcon size={18} /> : theme === 'light' ? <GhostIcon size={18} /> : <MoonIcon size={18} />}
        </button>
        <Link to="/settings" className="w-9 h-9 rounded-full bg-accent grid place-items-center font-bold text-black shrink-0" aria-label="Profile and settings" title={profile.name}>
          {(profile.name?.[0] || 'G').toUpperCase()}
        </Link>
      </div>
    </header>
  );
}

const tabs = [
  { to: '/', label: 'Home', Icon: HomeIcon },
  { to: '/search', label: 'Search', Icon: SearchIcon },
  { to: '/library', label: 'Library', Icon: LibraryIcon },
  { to: '/liked', label: 'Liked', Icon: HeartIcon },
];

export function BottomNav({ hasPlayer }) {
  return (
    <nav className={`md:hidden fixed left-0 right-0 z-20 glass bg-app border-t border-soft ${hasPlayer ? 'bottomnav-offset' : 'bottom-0 pb-safe'}`} aria-label="Mobile">
      <div className="grid grid-cols-4 h-14">
        {tabs.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to}
            className={({ isActive }) => `flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold ${isActive ? '' : 'text-dim'}`}
            style={({ isActive }) => isActive ? { color: 'var(--text)' } : undefined}>
            {({ isActive }) => (<><Icon size={21} active={isActive} />{label}</>)}
          </NavLink>
        ))}
      </div>
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
