import { NavLink, Link, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { AuthAvatar } from './GoogleLogin';
import { HomeIcon, SearchIcon, LibraryIcon, PlusIcon, HeartIcon, NoteIcon, ChevronLeftIcon, MoonIcon, SunIcon } from './Icons';

/**
 * Flags the scroll container's parent with data-scrolled so the top bar can gain
 * a hairline and shadow once content moves under it.
 *
 * The attribute goes on the parent rather than on <main> because the header
 * precedes <main> in the DOM, and CSS has no parent selector — a descendant
 * selector from a common ancestor is the only way to reach it.
 *
 * Passive listener with a boolean latch: it touches the DOM only on the
 * transition, not on every scroll frame.
 */
function useScrollSpy() {
  useEffect(() => {
    const el = document.getElementById('main');
    const host = el?.parentElement;
    if (!el || !host) return;
    let last = null;
    const apply = (on) => {
      if (on === last) return;
      last = on;
      host.setAttribute('data-scrolled', on ? 'true' : 'false');
    };
    const onScroll = () => apply(el.scrollTop > 8);
    apply(el.scrollTop > 8);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
}

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

const TAB_ROUTES = ['/', '/search', '/library', '/liked'];

export function TopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const onSearchPage = location.pathname === '/search';
  const onTab = TAB_ROUTES.includes(location.pathname);
  const theme = useStore(s => s.theme);
  const setTheme = useStore(s => s.setTheme);
  const [q, setQ] = useState('');
  const cycleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  useScrollSpy();

  return (
    <header className="topbar sticky top-0 z-20 pt-safe">
      <div className="flex items-center gap-1.5 px-3 py-2 sm:px-4 sm:py-2.5">
        {onTab ? (
          /* Brand lives in the header on phones: the sidebar that holds it on
             wide screens is hidden below md. */
          <Link to="/" className="flex items-center gap-2 pl-1 pr-2 py-1.5 shrink-0" aria-label="SoundWave home">
            <WaveLogo size={28} />
            <span className="hidden min-[340px]:block text-[17px] font-extrabold tracking-[-0.02em]" style={{ color: 'var(--text)' }}>SoundWave</span>
          </Link>
        ) : (
          <button onClick={() => navigate(-1)} className="btn-quiet w-9 h-9 grid place-items-center shrink-0" aria-label="Go back">
            <ChevronLeftIcon size={20} />
          </button>
        )}
        {/* The inline search is a wide-screen shortcut; on phones the Search
            tab owns search, so the header gives the space back to content. */}
        <div className="hidden md:block flex-1 max-w-xl relative">
          {!onSearchPage && (
          <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`); }}>
            <SearchIcon size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-dim pointer-events-none" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search" aria-label="Search"
              className="w-full bg-[var(--surface-2)] border border-transparent rounded-full pl-10 pr-4 py-2 text-[14px] outline-none transition-[background-color,border-color,box-shadow] duration-200 hover:bg-[var(--surface-3)] focus:bg-[var(--surface-1)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_rgba(29,185,84,.18)] placeholder:text-[var(--text-dim)]" />
          </form>
          )}
        </div>
        <div className="flex-1 md:hidden" />
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

export function BottomNav() {
  /* The bar owns the bottom edge (and the safe area) at all times; the mini
     player stacks above it via .mini-offset. h-14 must stay in sync with
     --bottomnav-h. */
  const showFull = useStore(s => s.showFullPlayer);
  return (
    <nav className="md:hidden fixed left-0 right-0 bottom-0 z-20 pb-safe glass border-t border-soft" style={{ background: 'var(--chrome)' }} aria-label="Mobile"
      aria-hidden={showFull || undefined}>
      <div className="grid grid-cols-4 h-14">
        {tabs.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to}
            className={({ isActive }) => `flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors duration-200 ${isActive ? 'accent' : 'text-dim'}`}>
            {({ isActive }) => (<>
              {/* active pill: a quiet accent wash marks the current tab without
                  adding a second colour to the bar */}
              <span className={`grid place-items-center rounded-full px-4 py-0.5 -my-0.5 transition-colors duration-200 ${isActive ? 'bg-[var(--accent-ring)]' : ''}`}>
                <Icon size={21} active={isActive} />
              </span>
              {label}
            </>)}
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
      {/* aligns with <main>'s content column: no extra inner inset */}
      <div className="max-w-6xl mx-auto py-2.5 px-4 rounded-xl bg-red-500/10 border border-red-500/30 text-sm font-bold" role="alert">
        You're offline — saved songs still play. We'll reconnect automatically.
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore(s => s.toasts);
  return (
    <div className="fixed left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 items-center pointer-events-none"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}>
      {toasts.map(t => (
        <div key={t.id} className={`toast-in px-4 py-2 rounded-full text-sm font-semibold shadow-lg ${t.kind === 'error' ? 'bg-red-600 text-white' : 'bg-accent text-black'}`}>{t.msg}</div>
      ))}
    </div>
  );
}
