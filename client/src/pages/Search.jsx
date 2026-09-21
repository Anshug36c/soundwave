import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, debounce, tasteFiltered } from '../services/musicApi';
import { useStore } from '../store/useStore';
import { SongRow, AlbumCard, ArtistCard, PlaylistCard, SkeletonList } from '../components/Cards';
import { MicIcon, SlidersIcon, NoteIcon, DiscIcon, ClockIcon, BoltIcon, SearchIcon, CloseIcon } from '../components/Icons';

const TABS = ['Songs', 'Albums', 'Artists', 'YouTube'];
const TRENDING = ['AP Dhillon', 'Diljit Dosanjh', 'Guru Randhawa', 'Jasmine Sandlas', 'Tulsi Kumar', 'Karan Aujla', 'Shubh', 'Prem Dhillon'];
const EMPTY_FILTERS = { y: '', minD: '', maxD: '', lang: '', exp: '' };

const PROVIDER_LABEL = { djp: 'DJPunjab', dj: 'DJJohal', mrj: 'Mr-Jatt', saavn: 'Saavn' };

function SugBtn({ s, idx, active, onPick, Icon }) {
  const on = idx === active;
  return (
    <button id={`sug-opt-${idx}`} role="option" aria-selected={on}
      onMouseDown={e => e.preventDefault()} onClick={() => onPick(s.q)}
      className={`w-full text-left px-3 py-3 min-h-[44px] rounded-lg text-sm font-semibold truncate ${on ? 'bg-accent text-black' : 'bg-hoverable'}`}>
      <Icon size={14} className="inline mr-1.5 -mt-0.5" />{s.text}
    </button>
  );
}

export default function Search() {
  const [params] = useSearchParams();
  const initial = params.get('q') || '';
  const tabParam = params.get('tab');
  const initialTab = TABS.includes(tabParam) ? tabParam : 'Songs';
  const [q, setQ] = useState(initial);
  const [tab, setTab] = useState(initialTab);
  const [results, setResults] = useState({ songs: [], albums: [], artists: [], youtube: [] });
  const [loading, setLoading] = useState(false);
  const [suggest, setSuggest] = useState({ songs: [], albums: [], artists: [] });
  const [showSuggest, setShowSuggest] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [sugActive, setSugActive] = useState(-1);
  const [songCap, setSongCap] = useState(20);
  const [degraded, setDegraded] = useState([]);
  const [degradedOff, setDegradedOff] = useState(false);
  const [listening, setListening] = useState(false);
  const pushSearch = useStore(s => s.pushSearch);
  const searchHistory = useStore(s => s.searchHistory);
  const clearSearchHistory = useStore(s => s.clearSearchHistory);
  const disliked = useStore(s => s.disliked);
  const hiddenArtists = useStore(s => s.hiddenArtists);
  // hoisted: stable identity across keystrokes so memoized rows skip re-render
  const visibleSongs = useMemo(() => tasteFiltered(results.songs, disliked, hiddenArtists), [results.songs, disliked, hiddenArtists]);
  const visibleYT = useMemo(() => tasteFiltered(results.youtube || [], disliked, hiddenArtists), [results.youtube, disliked, hiddenArtists]);
  // Real YouTube videos: these play through the embedded player, so unlike the
  // YouTube Music rows they are the actual video, not a substituted match.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const recogRef = useRef(null);
  // stale-request guards: only the newest query may touch state; older ones
  // are aborted outright so fast typing can never show frozen/wrong results
  const runSeq = useRef(0);
  const runCtrl = useRef(null);
  const sugSeq = useRef(0);
  const sugCtrl = useRef(null);
  const submitSeq = useRef(0);
  const inputRef = useRef(null);
  // a finger scrolling the suggestion list blurs the input; without this flag
  // the blur-timeout would unmount the list mid-gesture
  const listTouch = useRef(false);
  const [error, setError] = useState(false);
  // The layout viewport does not shrink when a phone keyboard opens, so the
  // only honest measure of the visible area is the visual viewport. Cap the
  // suggestion list to it so options are never hidden behind the keyboard.
  const [sugMax, setSugMax] = useState(320);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const f = () => {
      const el = inputRef.current;
      const bottom = el ? el.getBoundingClientRect().bottom : 120;
      setSugMax(Math.min(420, Math.max(160, v.height - bottom - 12)));
    };
    f();
    v.addEventListener('resize', f);
    v.addEventListener('scroll', f);
    return () => { v.removeEventListener('resize', f); v.removeEventListener('scroll', f); };
  }, []);
  useEffect(() => () => {
    try { runCtrl.current?.abort(); } catch { /* noop */ }
    try { sugCtrl.current?.abort(); } catch { /* noop */ }
  }, []);

  const run = useMemo(() => debounce(async (query) => {
    const my = ++runSeq.current;
    try { runCtrl.current?.abort(); } catch { /* noop */ }
    const ctrl = new AbortController();
    runCtrl.current = ctrl;
    if (!query.trim()) { setResults({ songs: [], albums: [], artists: [], youtube: [] }); setLoading(false); return; }
    setLoading(true);
    setError(false);
    try {
      const f = filtersRef.current;
      const r = await api.search(query.trim(), 'all', {
        y: f.y.trim(), minD: f.minD ? +f.minD * 60 : '', maxD: f.maxD ? +f.maxD * 60 : '',
        lang: f.lang, exp: f.exp,
      }, { signal: ctrl.signal });
      if (runSeq.current !== my) return; // stale — superseded by a newer query
      setResults(r);
      pushSearch(query.trim());
    } catch (err) {
      /* aborted/stale: stay silent; a real failure gets a visible retry state */
      if (runSeq.current !== my) return;
      if (err?.name !== 'AbortError') setError(true);
    }
    if (runSeq.current === my) setLoading(false);
  }, 400), []);

  const fetchSuggest = useMemo(() => debounce(async (query) => {
    const my = ++sugSeq.current;
    try { sugCtrl.current?.abort(); } catch { /* noop */ }
    const ctrl = new AbortController();
    sugCtrl.current = ctrl;
    if (query.trim().length < 2) { setSuggest({ songs: [], albums: [], artists: [] }); setShowSuggest(false); return; }
    try {
      const r = await api.suggest(query.trim(), 8, { signal: ctrl.signal });
      if (sugSeq.current !== my) return;
      setSuggest(r);
      setShowSuggest(true);
    } catch { /* stale — ignore */ }
  }, 220), []);

  useEffect(() => { setQ(initial); setTab(initialTab); if (initial) { setLoading(true); run(initial); } }, [initial, params]);
  useEffect(() => { api.health().then(h => { if (h?.degraded?.length) setDegraded(h.degraded); }).catch(() => {}); }, []);
  useEffect(() => { setSugActive(-1); }, [suggest]);
  useEffect(() => { setSongCap(20); }, [results]);
  useEffect(() => { if (sugActive >= 0) { try { document.getElementById(`sug-opt-${sugActive}`)?.scrollIntoView({ block: 'nearest' }); } catch {} } }, [sugActive]);

  const submit = (query) => {
    const v = (query ?? q).trim();
    if (!v) return;
    submitSeq.current++;
    sugSeq.current++; // invalidate any suggest already fired or in flight
    try { fetchSuggest.cancel(); } catch { /* noop */ } // kill queued-but-unfired calls
    try { sugCtrl.current?.abort(); } catch { /* noop */ }
    setShowSuggest(false);
    setQ(v);
    setLoading(true);
    setError(false);
    run(v);
    // dismiss the keyboard so results own the screen (Enter or suggestion tap)
    try { inputRef.current?.blur(); } catch { /* noop */ }
  };

  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    if (listening) { try { recogRef.current?.stop(); } catch {} return; }
    try {
      const rec = new SR();
      recogRef.current = rec;
      rec.lang = navigator.language || 'en-IN';
      rec.interimResults = false;
      rec.onresult = (e) => {
        const text = e.results?.[0]?.[0]?.transcript || '';
        if (text.trim()) submit(text.trim());
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => setListening(false);
      rec.start();
      setListening(true);
    } catch { setListening(false); }
  };
  const voiceSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const filtersActive = !!(filters.y || filters.minD || filters.maxD || filters.lang || filters.exp);
  const hasSuggest = suggest.songs.length + suggest.albums.length + suggest.artists.length > 0;
  const emptyResults = !results.songs.length && !results.albums.length && !results.artists.length && !(results.youtube || []).length;
  const sugItems = useMemo(() => [...suggest.songs, ...suggest.artists, ...suggest.albums], [suggest]);
  const playlists = useStore(s => s.playlists);
  const matchPlaylists = q.trim() ? playlists.filter(p => p.name.toLowerCase().includes(q.trim().toLowerCase())) : [];

  const setF = (k, v) => {
    const nf = { ...filtersRef.current, [k]: v };
    setFilters(nf);
    if (q.trim()) { setLoading(true); run(q.trim()); }
  };

  return (
    <div className="pb-8">
      {/* sticky so the field, voice and filter controls stay reachable (and the
          suggestions stay in view) no matter how far results are scrolled.
          -top-4/pt-4: the sticky offset resolves against main's padded
          scrollport, so without the negative top a 16px seam of scrolling
          content would show above the bar; the padding keeps rest layout. */}
      <div className="relative sticky -top-4 pt-4 z-10 bg-app pb-2">
        <div className="flex gap-2">
          <div className="relative flex-1 min-w-0">
            <SearchIcon size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-dim pointer-events-none" />
            <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSugActive(-1); setError(false); setLoading(true); run(e.target.value); fetchSuggest(e.target.value); }}
              onFocus={() => { if (hasSuggest) setShowSuggest(true); }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown' && showSuggest && sugItems.length) { e.preventDefault(); setSugActive(a => (a + 1) % sugItems.length); }
                else if (e.key === 'ArrowUp' && showSuggest && sugItems.length) { e.preventDefault(); setSugActive(a => (a - 1 + sugItems.length) % sugItems.length); }
                else if (e.key === 'Enter') { if (showSuggest && sugActive >= 0 && sugItems[sugActive]) submit(sugItems[sugActive].q); else submit(); }
                else if (e.key === 'Escape') { if (showSuggest) setShowSuggest(false); else inputRef.current?.blur(); }
              }}
              onBlur={() => setTimeout(() => { if (!listTouch.current) setShowSuggest(false); }, 150)}
              placeholder="Songs, artists, albums — try “songs like Desires”" enterKeyHint="search"
              autoCapitalize="off" autoComplete="off" autoCorrect="off" spellCheck={false}
              role="combobox" aria-expanded={showSuggest && hasSuggest} aria-controls="search-suggest" aria-autocomplete="list"
              aria-activedescendant={sugActive >= 0 ? `sug-opt-${sugActive}` : undefined}
              className="w-full field-hero" data-clear={q ? 'true' : undefined} aria-label="Search music" />
            {q && (
              <button onClick={() => { setQ(''); setError(false); setResults({ songs: [], albums: [], artists: [], youtube: [] }); setShowSuggest(false); setSugActive(-1); inputRef.current?.focus(); }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-10 h-10 grid place-items-center rounded-full text-dim active:scale-90 transition-transform" aria-label="Clear search">
                <CloseIcon size={16} />
              </button>
            )}
          </div>
          {voiceSupported && (
            <button onClick={startVoice} title="Voice search"
              className={`shrink-0 w-12 rounded-2xl border border-soft grid place-items-center ${listening ? 'bg-red-500/80 text-white animate-pulse' : 'bg-soft text-dim'}`}
              aria-label="Voice search"><MicIcon size={20} /></button>
          )}
          <button onClick={() => setShowFilters(!showFilters)} title="Filters"
            className={`shrink-0 w-12 rounded-2xl border grid place-items-center relative ${showFilters || filtersActive ? 'border-green-500 bg-green-500/10' : 'border-soft bg-soft text-dim'}`}
            aria-label="Search filters"><SlidersIcon size={20} />{filtersActive && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-green-500" />}</button>
        </div>

        {showSuggest && hasSuggest && (
          <div id="search-suggest" role="listbox" aria-label="Search suggestions" style={{ maxHeight: sugMax }}
            onTouchStart={() => { listTouch.current = true; }}
            onTouchEnd={() => setTimeout(() => { listTouch.current = false; }, 400)}
            onTouchCancel={() => { listTouch.current = false; }}
            className="absolute z-30 left-0 right-0 mt-2 panel p-2 overflow-y-auto sheet-scroll">
            {suggest.songs.length > 0 && <p className="px-3 pt-1 t-eyebrow">SONGS</p>}
            {suggest.songs.map((s, i) => <SugBtn key={`s${i}`} s={s} idx={i} active={sugActive} onPick={submit} Icon={NoteIcon} />)}
            {suggest.artists.length > 0 && <p className="px-3 pt-2 t-eyebrow">ARTISTS</p>}
            {suggest.artists.map((s, i) => <SugBtn key={`a${i}`} s={s} idx={suggest.songs.length + i} active={sugActive} onPick={submit} Icon={MicIcon} />)}
            {suggest.albums.length > 0 && <p className="px-3 pt-2 t-eyebrow">ALBUMS</p>}
            {suggest.albums.map((s, i) => <SugBtn key={`l${i}`} s={s} idx={suggest.songs.length + suggest.artists.length + i} active={sugActive} onPick={submit} Icon={DiscIcon} />)}
          </div>
        )}
      </div>

      {showFilters && (
        <div className="panel p-4 mt-3 flex flex-wrap gap-3 items-end">
          <label className="t-eyebrow">Year
            <input value={filters.y} onChange={e => setF('y', e.target.value)} placeholder="2021 or 2000s"
              className="field block mt-1.5 w-32" /></label>
          <label className="t-eyebrow">Min (min)
            <input value={filters.minD} onChange={e => setF('minD', e.target.value.replace(/[^0-9]/g, ''))} placeholder="—"
              inputMode="numeric" className="field block mt-1.5 w-20" /></label>
          <label className="t-eyebrow">Max (min)
            <input value={filters.maxD} onChange={e => setF('maxD', e.target.value.replace(/[^0-9]/g, ''))} placeholder="—"
              inputMode="numeric" className="field block mt-1.5 w-20" /></label>
          <label className="t-eyebrow">Language
            <select value={filters.lang} onChange={e => setF('lang', e.target.value)}
              className="field block mt-1.5">
              <option value="">Any</option><option value="punjabi">Punjabi</option><option value="hindi">Hindi</option><option value="english">English</option>
            </select></label>
          <label className="t-eyebrow">Lyrics
            <select value={filters.exp} onChange={e => setF('exp', e.target.value)}
              className="field block mt-1.5">
              <option value="">Any</option><option value="clean">Clean only</option>
            </select></label>
          {filtersActive && <button onClick={() => { setFilters(EMPTY_FILTERS); if (q.trim()) { setLoading(true); run(q.trim()); } }}
            className="chip">Clear</button>}
        </div>
      )}

      {(results.nl?.note || results.nl?.mode === 'similar' || results.nl?.cleaned) && q && (
        <div className="callout mt-4 font-semibold">
          {results.nl.mode === 'similar' ? `Songs like ${results.nl.refLabel || results.nl.ref}`
            : results.nl.note ? `${results.nl.note}`
            : `Showing matches for “${results.nl.cleaned}”`}
        </div>
      )}
      {results.didYouMean && q && !loading && results.songs.length === 0 && (
        <div className="mt-4 text-sm">No matches. Did you mean{' '}
          <button onClick={() => submit(results.didYouMean)} className="font-semibold accent underline underline-offset-2">{results.didYouMean}</button>?
        </div>
      )}
      {results.didYouMean && q && !loading && results.songs.length > 0 && (
        <div className="mt-4 text-sm">Did you mean{' '}
          <button onClick={() => submit(results.didYouMean)} className="font-semibold accent underline underline-offset-2">{results.didYouMean}</button>?
        </div>
      )}

      {!q && (
        <div className="mt-6">
          {searchHistory.length > 0 && (
            <div className="mb-6">
              <div className="flex justify-between items-center mb-2"><h3 className="h-sub">Recent searches</h3>
                <button onClick={clearSearchHistory} className="t-eyebrow">CLEAR</button></div>
              <div className="flex flex-wrap gap-2">{searchHistory.map(h => <button key={h} onClick={() => submit(h)} className="card px-4 py-2 text-sm font-semibold inline-flex items-center gap-1.5"><ClockIcon size={15} />{h}</button>)}</div>
            </div>
          )}
          <h3 className="font-extrabold mb-2">Trending searches</h3>
          <div className="flex flex-wrap gap-2">{TRENDING.map(t => <button key={t} onClick={() => submit(t)} className="card px-4 py-2 text-sm font-semibold inline-flex items-center gap-1.5"><BoltIcon size={15} />{t}</button>)}</div>
        </div>
      )}

      {q && error && !loading && (
        <div className="callout mt-5 flex items-center justify-between gap-3" role="alert">
          <span className="font-semibold">Search failed — check your connection and try again.</span>
          <button onClick={() => { setError(false); setLoading(true); run(q.trim()); }} className="chip chip-active shrink-0">Retry</button>
        </div>
      )}
      {q && !loading && !error && emptyResults && (
        <div className="mt-10 mb-4 flex flex-col items-center text-center anim-in">
          <span className="w-16 h-16 rounded-full bg-[var(--surface-2)] grid place-items-center text-dim"><NoteIcon size={26} /></span>
          <p className="mt-4 font-bold">No results for “{q}”</p>
          <p className="t-caption mt-1 max-w-[260px]">Check the spelling, or try an artist, album or song name.</p>
          <div className="flex flex-wrap gap-2 justify-center mt-4">{TRENDING.slice(0, 4).map(t => <button key={t} onClick={() => submit(t)} className="chip">{t}</button>)}</div>
        </div>
      )}

      {q && (
        <div className="flex gap-2 mt-3 overflow-x-auto no-scrollbar fade-r">
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-5 py-2 rounded-full text-sm font-bold shrink-0 ${tab === t ? 'bg-accent text-black' : 'bg-white/10'}`}>{t}</button>
          ))}
        </div>
      )}

      {degraded.length > 0 && !degradedOff && q && (
        <div className="mt-4 px-4 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-sm font-semibold flex items-center justify-between gap-2">
          <span>{degraded.map(d => PROVIDER_LABEL[d] || d).join(', ')} {degraded.length > 1 ? 'are' : 'is'} slow right now — showing other sources.</span>
          <button onClick={() => setDegradedOff(true)} className="text-dim font-bold shrink-0" aria-label="Dismiss">✕</button>
        </div>
      )}
      {q && matchPlaylists.length > 0 && (
        <div className="mt-5">
          <h3 className="font-extrabold mb-2">Your playlists</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 [&>*]:min-w-0 [&>*]:max-w-none">{matchPlaylists.map(p => <PlaylistCard key={p.id} playlist={p} />)}</div>
        </div>
      )}
      {loading && emptyResults && <div className="mt-5"><SkeletonList /></div>}
      {loading && !emptyResults && <div className="h-1 mt-5 rounded-full bg-white/10 overflow-hidden" aria-hidden><div className="h-full w-1/3 bg-green-500 rounded-full animate-pulse" /></div>}

      {q && tab === 'Songs' && results.artist?.name && (
        <Link to={`/artist/all/${encodeURIComponent(results.artist.name)}`}
          className="mt-4 flex items-center justify-between gap-2 card p-4 font-bold text-sm">
          <span>All songs by {results.artist.name} — every provider</span><span aria-hidden>→</span>
        </Link>
      )}

      {q && tab === 'Songs' && !emptyResults && (() => {
        const visible = visibleSongs;
        const hidden = results.songs.length - visible.length;
        const shown = visible.slice(0, songCap);
        return (
        <div key={`songs-${q}`} className="card p-2 mt-4 flex flex-col anim-in">{shown.map((t, i) => <SongRow key={t.id} track={t} index={i} context={visible} />)}
          {visible.length === 0 && <p className="p-4 text-sm text-dim">No songs found{filtersActive ? ' with these filters' : ''}.</p>}
          {hidden > 0 && <p className="px-4 py-1 text-[11px] text-dim font-semibold">{hidden} hidden by your taste filters.</p>}
          {visible.length > songCap && <button onClick={() => setSongCap(c => c + 20)} className="m-2 py-2.5 rounded-xl text-sm font-bold bg-white/10">Show more ({visible.length - songCap} more)</button>}</div>
        );
      })()}
      {q && tab === 'Albums' && !emptyResults && (
        <div key={`albums-${q}`} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4 anim-in [&>*]:min-w-0 [&>*]:max-w-none">{results.albums.map(a => <AlbumCard key={a.id} album={a} />)}
          {results.albums.length === 0 && <p className="p-4 text-sm text-dim col-span-full">No albums found.</p>}</div>
      )}
      {q && tab === 'Artists' && !emptyResults && (
        <div key={`artists-${q}`} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4 anim-in [&>*]:min-w-0 [&>*]:max-w-none">{results.artists.map(a => <ArtistCard key={a.id} artist={a} />)}
          {results.artists.length === 0 && <p className="p-4 text-sm text-dim col-span-full">No artists found.</p>}</div>
      )}
      {q && tab === 'YouTube' && !emptyResults && (
        <>
          <div key={`yt-${q}`} className="card p-2 mt-4 flex flex-col anim-in">
              <p className="px-4 pt-2 pb-1 text-[11px] font-extrabold tracking-widest text-dim">YOUTUBE</p>
            {visibleYT.map((t, i) => <SongRow key={t.id} track={t} index={i} context={visibleYT} />)}
            {visibleYT.length === 0 && <p className="p-4 text-sm text-dim">No YouTube audio matches found.</p>}
          </div>
        </>
      )}
    </div>
  );
}
