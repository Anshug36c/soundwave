import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { api, debounce } from '../services/musicApi';
import { PlayIcon, PauseIcon, NextIcon, PrevIcon, ShuffleIcon, RepeatIcon, HeartIcon, SlidersIcon, QueueIcon, SunIcon, MoonIcon, HomeIcon, SearchIcon, ChartIcon, LibraryIcon, GearIcon, NoteIcon, ClockIcon } from './Icons';

/** Fuzzy subsequence score (Monochrome-style Ctrl+K palette, dependency-free). */
function fuzzy(query, text) {
  const q = query.toLowerCase().trim();
  const t = String(text || '').toLowerCase();
  if (!q) return 0;
  if (t.includes(q)) return 100 + q.length;
  let qi = 0, score = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { score += (i === qi ? 3 : 1); qi++; }
  }
  return qi === q.length ? score : -1;
}

export default function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [live, setLive] = useState([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);
  const cycleRepeat = useStore(s => s.cycleRepeat);
  const history = useStore(s => s.history);
  const index = useStore(s => s.index);
  const isPlaying = useStore(s => s.isPlaying);
  const liked = useStore(s => s.liked);
  const next = useStore(s => s.next);
  const playTrack = useStore(s => s.playTrack);
  const playTracks = useStore(s => s.playTracks);
  const playlists = useStore(s => s.playlists);
  const prev = useStore(s => s.prev);
  const queue = useStore(s => s.queue);
  const repeat = useStore(s => s.repeat);
  const setShowQueue = useStore(s => s.setShowQueue);
  const setStudioOn = useStore(s => s.setStudioOn);
  const setTheme = useStore(s => s.setTheme);
  const shuffle = useStore(s => s.shuffle);
  const studioOn = useStore(s => s.studioOn);
  const theme = useStore(s => s.theme);
  const toggleLike = useStore(s => s.toggleLike);
  const togglePlay = useStore(s => s.togglePlay);
  const toggleShuffle = useStore(s => s.toggleShuffle);
  const s = { cycleRepeat, history, index, isPlaying, liked, next, playTrack, playTracks, playlists, prev, queue, repeat, setShowQueue, setStudioOn, setTheme, shuffle, studioOn, theme, toggleLike, togglePlay, toggleShuffle };

  useEffect(() => {
    const toggle = () => setOpen(v => !v);
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); toggle(); }
    };
    const onEvent = () => setOpen(v => !v);
    window.addEventListener('keydown', onKey);
    window.addEventListener('soundwave:palette', onEvent);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('soundwave:palette', onEvent); };
  }, []);

  useEffect(() => {
    if (open) { setQ(''); setLive([]); setActive(0); setTimeout(() => inputRef.current?.focus(), 30); }
  }, [open ]);

  const liveSearch = useMemo(() => debounce(async (query) => {
    if (query.trim().length < 2) { setLive([]); setSearching(false); return; }
    setSearching(true);
    try {
      const r = await api.search(query.trim());
      setLive((r.songs || []).slice(0, 6));
    } catch { /* noop */ }
    setSearching(false);
  }, 350), []);

  useEffect(() => { liveSearch(q); }, [q, liveSearch]);

  const track = s.index >= 0 ? s.queue[s.index] : null;
  const cycleTheme = () => s.setTheme(s.theme === 'dark' ? 'light' : 'dark');

  const actions = [
    { icon: s.isPlaying ? <PauseIcon size={17} /> : <PlayIcon size={17} />, label: s.isPlaying ? 'Pause' : 'Play', run: () => s.togglePlay() },
    { icon: <NextIcon size={17} />, label: 'Next track', run: () => s.next() },
    { icon: <PrevIcon size={17} />, label: 'Previous track', run: () => s.prev() },
    { icon: <ShuffleIcon size={17} />, label: `${s.shuffle ? 'Disable' : 'Enable'} shuffle`, run: () => s.toggleShuffle() },
    { icon: <RepeatIcon size={17} />, label: `Repeat: ${s.repeat} (cycle)`, run: () => s.cycleRepeat() },
    ...(track ? [{ icon: <HeartIcon size={17} filled={!!s.liked[track.id]} />, label: `${s.liked[track.id] ? 'Unlike' : 'Like'} "${track.title}"`, run: () => s.toggleLike(track) }] : []),
    { icon: <SlidersIcon size={17} />, label: `${s.studioOn ? 'Disable' : 'Enable'} Studio sound`, run: () => s.setStudioOn(!s.studioOn) },
    { icon: <QueueIcon size={17} />, label: 'Open queue', run: () => s.setShowQueue(true) },
    { icon: <SunIcon size={17} />, label: `Theme: ${s.theme} (cycle)`, run: cycleTheme },
    { icon: <MoonIcon size={17} />, label: 'Sleep timer settings', run: () => { navigate('/settings'); } },
  ];
  const pages = [
    { icon: <HomeIcon size={17} />, label: 'Go to Home', run: () => navigate('/') },
    { icon: <SearchIcon size={17} />, label: 'Go to Search', run: () => navigate('/search') },
    { icon: <ChartIcon size={17} />, label: 'Go to Charts', run: () => navigate('/charts') },
    { icon: <LibraryIcon size={17} />, label: 'Go to Library', run: () => navigate('/library') },
    { icon: <HeartIcon size={17} />, label: 'Go to Liked Songs', run: () => navigate('/liked') },
    { icon: <GearIcon size={17} />, label: 'Go to Settings', run: () => navigate('/settings') },
  ];

  const groups = [];
  if (live.length) groups.push({ title: searching ? 'Searching…' : 'Top results — play instantly', items: live.map(t => ({
    icon: <NoteIcon size={17} />, label: t.title, sub: t.artist?.name, run: () => s.playTracks(live, live.findIndex(x => x.id === t.id)),
  })) });
  const match = (list) => list
    .map(a => ({ ...a, score: q ? fuzzy(q, a.label) : 0 }))
    .filter(a => !q || a.score >= 0)
    .sort((a, b) => b.score - a.score);
  const mActions = match(actions);
  const mPages = match(pages);
  const lib = [
    ...s.playlists.map(p => ({ icon: <NoteIcon size={17} />, label: `Playlist: ${p.name}`, sub: `${p.tracks.length} tracks`, run: () => navigate(`/playlist/${encodeURIComponent(p.id)}`) })),
    ...Object.values(s.liked).slice(0, 5).map(t => ({ icon: <HeartIcon size={17} />, label: t.title, sub: t.artist?.name, run: () => s.playTrack(t, Object.values(s.liked)) })),
    ...s.history.slice(0, 5).map(t => ({ icon: <ClockIcon size={17} />, label: t.title, sub: t.artist?.name, run: () => s.playTrack(t, s.history) })),
  ];
  const mLib = match(lib);
  if (mActions.length) groups.push({ title: 'Actions', items: mActions });
  if (mPages.length) groups.push({ title: 'Go to', items: mPages });
  if (mLib.length) groups.push({ title: 'Library & history', items: mLib.slice(0, 10) });

  const flat = groups.flatMap(g => g.items);
  useEffect(() => { setActive(0); }, [q, live.length]);

  const runItem = (item) => { setOpen(false); setQ(''); item?.run(); };

  if (!open) return null;
  return (
    <div className="palette-overlay" onClick={() => setOpen(false)} role="dialog" aria-label="Command palette">
      <div className="palette-modal" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 border-b border-soft">
          <SearchIcon size={17} className="text-dim shrink-0" />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Type a command or search music…"
            className="flex-1 bg-transparent py-3.5 outline-none font-semibold" aria-label="Command palette input"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, flat.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
              else if (e.key === 'Enter') runItem(flat[active]);
              else if (e.key === 'Escape') setOpen(false);
            }} />
          <kbd className="text-[10px] font-bold text-dim border border-soft rounded px-1.5 py-0.5">ESC</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {searching && live.length === 0 && <p className="p-3 text-sm text-dim">Searching…</p>}
          {groups.map(g => (
            <div key={g.title} className="mb-1">
              <p className="px-3 pt-2 pb-1 text-[10px] font-extrabold tracking-widest text-dim">{g.title.toUpperCase()}</p>
              {g.items.map(item => {
                const idx = flat.indexOf(item);
                return (
                  <button key={`${g.title}-${item.label}`} onClick={() => runItem(item)}
                    onMouseEnter={() => setActive(idx)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm ${idx === active ? 'bg-accent text-black' : ''}`}>
                    <span className="grid place-items-center shrink-0">{item.icon}</span>
                    <span className="font-semibold truncate flex-1">{item.label}</span>
                    {item.sub && <span className={`text-xs truncate max-w-[40%] ${idx === active ? 'text-black/70' : 'text-dim'}`}>{item.sub}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && !searching && <p className="p-4 text-sm text-dim text-center">No matches. Try another search.</p>}
        </div>
        <div className="px-4 py-2 border-t border-soft text-[11px] text-dim font-semibold">↑↓ navigate · ⏎ run · Ctrl+K toggle</div>
      </div>
    </div>
  );
}
