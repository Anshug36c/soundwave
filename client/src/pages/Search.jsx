import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, debounce, tasteFiltered } from '../services/musicApi';
import { useStore } from '../store/useStore';
import { SongRow, AlbumCard, ArtistCard, SkeletonList } from '../components/Cards';
import { MicIcon, SlidersIcon, NoteIcon, DiscIcon, ClockIcon, BoltIcon } from '../components/Icons';

const TABS = ['Songs', 'Albums', 'Artists'];
const TRENDING = ['AP Dhillon', 'Diljit Dosanjh', 'Guru Randhawa', 'Jasmine Sandlas', 'Tulsi Kumar', 'Karan Aujla', 'Shubh', 'Prem Dhillon'];
const EMPTY_FILTERS = { y: '', minD: '', maxD: '', lang: '', exp: '' };

export default function Search() {
  const [params] = useSearchParams();
  const initial = params.get('q') || '';
  const tabParam = params.get('tab');
  const initialTab = TABS.includes(tabParam) ? tabParam : 'Songs';
  const [q, setQ] = useState(initial);
  const [tab, setTab] = useState(initialTab);
  const [results, setResults] = useState({ songs: [], albums: [], artists: [] });
  const [loading, setLoading] = useState(false);
  const [suggest, setSuggest] = useState({ songs: [], albums: [], artists: [] });
  const [showSuggest, setShowSuggest] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [listening, setListening] = useState(false);
  const pushSearch = useStore(s => s.pushSearch);
  const searchHistory = useStore(s => s.searchHistory);
  const clearSearchHistory = useStore(s => s.clearSearchHistory);
  const disliked = useStore(s => s.disliked);
  const hiddenArtists = useStore(s => s.hiddenArtists);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const recogRef = useRef(null);

  const run = useMemo(() => debounce(async (query) => {
    if (!query.trim()) { setResults({ songs: [], albums: [], artists: [] }); setLoading(false); return; }
    setLoading(true);
    try {
      const f = filtersRef.current;
      const r = await api.search(query.trim(), 'all', {
        y: f.y.trim(), minD: f.minD ? +f.minD * 60 : '', maxD: f.maxD ? +f.maxD * 60 : '',
        lang: f.lang, exp: f.exp,
      });
      setResults(r);
      pushSearch(query.trim());
    } catch { /* keep old */ }
    setLoading(false);
  }, 400), []);

  const fetchSuggest = useMemo(() => debounce(async (query) => {
    if (query.trim().length < 2) { setSuggest({ songs: [], albums: [], artists: [] }); return; }
    try {
      const r = await api.suggest(query.trim());
      setSuggest(r);
      setShowSuggest(true);
    } catch { /* no suggestions */ }
  }, 220), []);

  useEffect(() => { setQ(initial); setTab(initialTab); if (initial) { setLoading(true); run(initial); } }, [initial, params]);

  const submit = (query) => {
    const v = (query ?? q).trim();
    if (!v) return;
    setShowSuggest(false);
    setQ(v);
    setLoading(true);
    run(v);
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

  const setF = (k, v) => {
    const nf = { ...filtersRef.current, [k]: v };
    setFilters(nf);
    if (q.trim()) { setLoading(true); run(q.trim()); }
  };

  return (
    <div className="pb-8">
      <div className="relative">
        <div className="flex gap-2">
          <input value={q} onChange={e => { setQ(e.target.value); setLoading(true); run(e.target.value); fetchSuggest(e.target.value); }}
            onFocus={() => { if (hasSuggest) setShowSuggest(true); }}
            onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setShowSuggest(false); }}
            onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
            placeholder="Songs, artists, albums — try “songs like Desires”" enterKeyHint="search"
            className="w-full bg-soft border border-soft rounded-2xl px-5 py-3.5 text-base outline-none focus:border-green-500 font-semibold" aria-label="Search music" />
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
          <div className="absolute z-30 left-0 right-0 mt-2 panel p-2 max-h-80 overflow-y-auto sheet-scroll">
            {suggest.songs.length > 0 && <p className="px-3 pt-1 text-[11px] font-extrabold text-dim tracking-wide">SONGS</p>}
            {suggest.songs.map((s, i) => (
              <button key={`s${i}`} onMouseDown={e => e.preventDefault()} onClick={() => submit(s.q)}
                className="w-full text-left px-3 py-2.5 rounded-lg bg-hoverable text-sm font-semibold truncate"><NoteIcon size={14} className="inline mr-1.5 -mt-0.5" />{s.text}</button>
            ))}
            {suggest.artists.length > 0 && <p className="px-3 pt-2 text-[11px] font-extrabold text-dim tracking-wide">ARTISTS</p>}
            {suggest.artists.map((s, i) => (
              <button key={`a${i}`} onMouseDown={e => e.preventDefault()} onClick={() => submit(s.q)}
                className="w-full text-left px-3 py-2.5 rounded-lg bg-hoverable text-sm font-semibold truncate"><MicIcon size={14} className="inline mr-1.5 -mt-0.5" />{s.text}</button>
            ))}
            {suggest.albums.length > 0 && <p className="px-3 pt-2 text-[11px] font-extrabold text-dim tracking-wide">ALBUMS</p>}
            {suggest.albums.map((s, i) => (
              <button key={`l${i}`} onMouseDown={e => e.preventDefault()} onClick={() => submit(s.q)}
                className="w-full text-left px-3 py-2.5 rounded-lg bg-hoverable text-sm font-semibold truncate"><DiscIcon size={14} className="inline mr-1.5 -mt-0.5" />{s.text}</button>
            ))}
          </div>
        )}
      </div>

      {showFilters && (
        <div className="card p-3 mt-3 flex flex-wrap gap-3 items-end">
          <label className="text-xs font-bold text-dim">Year
            <input value={filters.y} onChange={e => setF('y', e.target.value)} placeholder="2021 or 2000s"
              className="block mt-1 bg-soft border border-soft rounded-lg px-3 py-1.5 text-sm font-semibold outline-none w-32" /></label>
          <label className="text-xs font-bold text-dim">Min (min)
            <input value={filters.minD} onChange={e => setF('minD', e.target.value.replace(/[^0-9]/g, ''))} placeholder="—"
              inputMode="numeric" className="block mt-1 bg-soft border border-soft rounded-lg px-3 py-1.5 text-sm font-semibold outline-none w-20" /></label>
          <label className="text-xs font-bold text-dim">Max (min)
            <input value={filters.maxD} onChange={e => setF('maxD', e.target.value.replace(/[^0-9]/g, ''))} placeholder="—"
              inputMode="numeric" className="block mt-1 bg-soft border border-soft rounded-lg px-3 py-1.5 text-sm font-semibold outline-none w-20" /></label>
          <label className="text-xs font-bold text-dim">Language
            <select value={filters.lang} onChange={e => setF('lang', e.target.value)}
              className="block mt-1 bg-soft border border-soft rounded-lg px-3 py-1.5 text-sm font-semibold outline-none">
              <option value="">Any</option><option value="punjabi">Punjabi</option><option value="hindi">Hindi</option><option value="english">English</option>
            </select></label>
          <label className="text-xs font-bold text-dim">Lyrics
            <select value={filters.exp} onChange={e => setF('exp', e.target.value)}
              className="block mt-1 bg-soft border border-soft rounded-lg px-3 py-1.5 text-sm font-semibold outline-none">
              <option value="">Any</option><option value="clean">Clean only</option>
            </select></label>
          {filtersActive && <button onClick={() => { setFilters(EMPTY_FILTERS); if (q.trim()) { setLoading(true); run(q.trim()); } }}
            className="text-xs font-bold px-3 py-2 rounded-full bg-white/10">Clear</button>}
        </div>
      )}

      {(results.nl?.note || results.nl?.mode === 'similar' || results.nl?.cleaned) && q && (
        <div className="mt-4 px-4 py-2.5 rounded-xl bg-blue-500/10 border border-blue-500/30 text-sm font-semibold">
          {results.nl.mode === 'similar' ? `Songs like ${results.nl.refLabel || results.nl.ref}`
            : results.nl.note ? `${results.nl.note}`
            : `Showing matches for “${results.nl.cleaned}”`}
        </div>
      )}
      {results.didYouMean && q && !loading && results.songs.length === 0 && (
        <div className="mt-4 text-sm">No matches. Did you mean{' '}
          <button onClick={() => submit(results.didYouMean)} className="font-bold text-green-500 underline">{results.didYouMean}</button>?
        </div>
      )}

      {!q && (
        <div className="mt-6">
          {searchHistory.length > 0 && (
            <div className="mb-6">
              <div className="flex justify-between items-center mb-2"><h3 className="font-extrabold">Recent searches</h3>
                <button onClick={clearSearchHistory} className="text-xs font-bold text-dim">CLEAR</button></div>
              <div className="flex flex-wrap gap-2">{searchHistory.map(h => <button key={h} onClick={() => submit(h)} className="card px-4 py-2 text-sm font-semibold inline-flex items-center gap-1.5"><ClockIcon size={15} />{h}</button>)}</div>
            </div>
          )}
          <h3 className="font-extrabold mb-2">Trending searches</h3>
          <div className="flex flex-wrap gap-2">{TRENDING.map(t => <button key={t} onClick={() => submit(t)} className="card px-4 py-2 text-sm font-semibold inline-flex items-center gap-1.5"><BoltIcon size={15} />{t}</button>)}</div>
        </div>
      )}

      {q && (
        <div className="flex gap-2 mt-5 overflow-x-auto no-scrollbar">
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-5 py-2 rounded-full text-sm font-bold shrink-0 ${tab === t ? 'bg-accent text-black' : 'bg-white/10'}`}>{t}</button>
          ))}
        </div>
      )}

      {loading && <div className="mt-5"><SkeletonList /></div>}

      {!loading && q && tab === 'Songs' && (() => {
        const visible = tasteFiltered(results.songs, disliked, hiddenArtists);
        const hidden = results.songs.length - visible.length;
        return (
        <div className="card p-2 mt-4 flex flex-col">{visible.map((t, i) => <SongRow key={t.id} track={t} index={i} context={visible} />)}
          {visible.length === 0 && <p className="p-4 text-sm text-dim">No songs found{filtersActive ? ' with these filters' : ''}.</p>}
          {hidden > 0 && <p className="px-4 py-1 text-[11px] text-dim font-semibold">{hidden} hidden by your taste filters.</p>}</div>
        );
      })()}
      {!loading && q && tab === 'Albums' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4 [&>*]:min-w-0 [&>*]:max-w-none">{results.albums.map(a => <AlbumCard key={a.id} album={a} />)}
          {results.albums.length === 0 && <p className="p-4 text-sm text-dim col-span-full">No albums found.</p>}</div>
      )}
      {!loading && q && tab === 'Artists' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4 [&>*]:min-w-0 [&>*]:max-w-none">{results.artists.map(a => <ArtistCard key={a.id} artist={a} />)}
          {results.artists.length === 0 && <p className="p-4 text-sm text-dim col-span-full">No artists found.</p>}</div>
      )}
    </div>
  );
}
