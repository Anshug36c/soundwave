import { NavLink, Link, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { AuthAvatar } from './GoogleLogin';
import { HomeIcon, SearchIcon, LibraryIcon, PlusIcon, HeartIcon, NoteIcon, ChevronLeftIcon, ChevronRightIcon, MoonIcon, SunIcon } from './Icons';

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
    <aside className="hidden md:flex w-[264px] shrink-0 flex-col h-full px-3 pt-5 pb-2">
      {/* No boxed panel: the sidebar is one continuous column with hairline
          separators, which is how Apple Music separates its sections. */}
      <div className="px-3">
        <Link to="/" className="flex items-center gap-2.5 text-[20px] font-bold tracking-[-0.02em]" style={{ color: 'var(--text)' }}>
          <WaveLogo size={30} /> SoundWave
        </Link>
      </div>

      <nav className="mt-7 flex flex-col gap-0.5 px-1" aria-label="Primary">
        {mainNav.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to}
            className={({ isActive }) => `nav-pill flex items-center gap-3.5 px-3 py-2 text-[15px] font-semibold ${isActive ? 'nav-active' : 'text-dim'}`}>
            {({ isActive }) => (<><Icon size={21} active={isActive} />{label}</>)}
          </NavLink>
        ))}
      </nav>

      <div className="mt-7 mx-3 border-t border-soft" aria-hidden="true" />

      <div className="mt-4 flex-1 overflow-y-auto min-h-0 px-1">
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="t-eyebrow">Playlists</span>
          <button onClick={() => setCreating(v => !v)} className="btn-quiet p-1.5" aria-label="Create playlist">
            <PlusIcon size={17} />
          </button>
        </div>
        {creating && (
          <form className="px-2 pb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; createPlaylist(name.trim()); setName(''); setCreating(false); toast('Playlist created'); }}>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Playlist name" className="w-full bg-soft border border-soft rounded-[10px] px-2.5 py-1.5 text-sm outline-none focus:border-[var(--accent)] transition-colors" />
            <button className="btn-accent px-3.5 text-sm shrink-0">Add</button>
          </form>
        )}
        <Link to="/liked" className="nav-pill flex items-center gap-3 px-2.5 py-2">
          <span className="w-10 h-10 rounded-[8px] grid place-items-center shrink-0 bg-gradient-to-br from-indigo-600 via-purple-500 to-purple-300 shadow-[var(--shadow-1)]">
            <HeartIcon size={17} filled className="text-white" />
          </span>
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold truncate" style={{ color: 'var(--text)' }}>Liked Songs</span>
            <span className="block t-caption truncate">{likedCount} songs</span>
          </span>
        </Link>
        {playlists.map(p => (
          <Link key={p.id} to={`/playlist/${encodeURIComponent(p.id)}`} className="nav-pill flex items-center gap-3 px-2.5 py-2">
            <span className="w-10 h-10 rounded-[8px] grid place-items-center shrink-0 bg-[var(--surface-2)] text-dim"><NoteIcon size={17} /></span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold truncate" style={{ color: 'var(--text)' }}>{p.name}</span>
              <span className="block t-caption truncate">{p.tracks.length} songs</span>
            </span>
          </Link>
        ))}
        {playlists.length === 0 && <p className="t-caption px-3 py-2">No playlists yet — create one.</p>}
      </div>
    </aside>
  );
}

export function TopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const onSearchPage = location.pathname === '/search';
  const theme = useStore(s => s.theme);
  const setTheme = useStore(s => s.setTheme);
  const [q, setQ] = useState('');
  const cycleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  return (
    <header className="sticky top-0 z-20 glass border-b border-soft" style={{ background: 'var(--chrome)' }}>
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button onClick={() => navigate(-1)} className="btn-quiet w-9 h-9 grid place-items-center shrink-0" aria-label="Go back">
          <ChevronLeftIcon size={18} />
        </button>
        <button onClick={() => navigate(1)} className="btn-quiet w-9 h-9 place-items-center shrink-0 hidden sm:grid" aria-label="Go forward">
          <ChevronRightIcon size={18} />
        </button>
        <div className="flex-1 max-w-xl relative">
          {/* one search bar per page: the Search page has the rich input, so the topbar yields there */}
          {!onSearchPage && (
          <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`); }}>
            <SearchIcon size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-dim pointer-events-none" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search" aria-label="Search"
              className="w-full bg-[var(--surface-2)] border border-transparent rounded-full pl-10 pr-4 py-2 text-[14px] outline-none transition-[background-color,border-color,box-shadow] duration-200 hover:bg-[var(--surface-3)] focus:bg-[var(--surface-1)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_rgba(29,185,84,.18)] placeholder:text-[var(--text-dim)]" />
          </form>
          )}
        </div>
        <button onClick={() => window.dispatchEvent(new Event('soundwave:palette'))} className="h-9 px-3 rounded-full bg-[var(--surface-2)] hover:bg-[var(--surface-3)] hidden sm:grid place-items-center text-[13px] font-semibold shrink-0 transition-colors" aria-label="Command palette" title="Command palette (Ctrl+K)">⌘K</button>
        <button onClick={cycleTheme} className="btn-quiet w-9 h-9 grid place-items-center shrink-0" aria-label="Cycle theme" title={`Theme: ${theme} (click to change)`}>
          {theme === 'dark' ? <SunIcon size={18} /> : <MoonIcon size={18} />}
        </button>
        <AuthAvatar />
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
    <nav className={`md:hidden fixed left-0 right-0 z-20 glass border-t border-soft ${hasPlayer ? 'bottomnav-offset' : 'bottom-0 pb-safe'}`} style={{ background: 'var(--chrome)' }} aria-label="Mobile">
      <div className="grid grid-cols-4 h-14">
        {tabs.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to}
            className={({ isActive }) => `flex flex-col items-center justify-center gap-1 text-[10px] font-semibold transition-colors duration-200 ${isActive ? 'accent' : 'text-dim'}`}>
            {({ isActive }) => (<><Icon size={22} active={isActive} />{label}</>)}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function OfflineBanner() {
  const [online, setOnline] = useState(() => { try { return navigator.onLine; } catch { return true; } });
  useEffect(() => {
    const f = () => setOnline(navigator.onLine);
    window.addEventListener('online', f);
    window.addEventListener('offline', f);
    return () => { window.removeEventListener('online', f); window.removeEventListener('offline', f); };
  }, []);
  if (online) return null;
  return (
    <div className="px-4 md:px-6 pt-3">
      <div className="max-w-6xl mx-auto px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-sm font-bold" role="alert">
        You're offline — saved songs still play. We'll reconnect automatically.
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore(s => s.toasts);
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 items-center pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className={`toast-in px-4 py-2 rounded-full text-sm font-semibold shadow-lg ${t.kind === 'error' ? 'bg-red-600 text-white' : 'bg-accent text-black'}`}>{t.msg}</div>
      ))}
    </div>
  );
}
