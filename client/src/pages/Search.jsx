import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, debounce } from '../services/musicApi';
import { useStore } from '../store/useStore';
import { SongRow, AlbumCard, ArtistCard, PlaylistCard, SkeletonList } from '../components/Cards';

const TABS = ['Songs', 'Albums', 'Artists', 'Playlists'];
const TRENDING = ['Arijit Singh', 'Taylor Swift', 'AP Dhillon', 'Lofi beats', 'Shreya Ghoshal', 'Drake', 'Bollywood 2026', 'Coldplay'];

export default function Search() {
  const [params] = useSearchParams();
  const initial = params.get('q') || '';
  const [q, setQ] = useState(initial);
  const [tab, setTab] = useState('Songs');
  const [results, setResults] = useState({ songs: [], albums: [], artists: [], playlists: [] });
  const [loading, setLoading] = useState(false);
  const pushSearch = useStore(s => s.pushSearch);
  const searchHistory = useStore(s => s.searchHistory);
  const clearSearchHistory = useStore(s => s.clearSearchHistory);

  const run = useMemo(() => debounce(async (query) => {
    if (!query.trim()) { setResults({ songs: [], albums: [], artists: [], playlists: [] }); setLoading(false); return; }
    setLoading(true);
    try {
      const r = await api.search(query.trim());
      setResults(r);
      pushSearch(query.trim());
    } catch { /* keep old */ }
    setLoading(false);
  }, 400), []);

  useEffect(() => { setQ(initial); if (initial) { setLoading(true); run(initial); } }, [initial]);

  return (
    <div className="pb-8">
      <input value={q} onChange={e => { setQ(e.target.value); setLoading(true); run(e.target.value); }}
        placeholder="What do you want to listen to?" autoFocus
        className="w-full bg-soft border border-soft rounded-2xl px-5 py-3.5 text-base outline-none focus:border-green-500 font-semibold" aria-label="Search music" />

      {!q && (
        <div className="mt-6">
          {searchHistory.length > 0 && (
            <div className="mb-6">
              <div className="flex justify-between items-center mb-2"><h3 className="font-extrabold">Recent searches</h3>
                <button onClick={clearSearchHistory} className="text-xs font-bold text-dim">CLEAR</button></div>
              <div className="flex flex-wrap gap-2">{searchHistory.map(h => <button key={h} onClick={() => { setQ(h); setLoading(true); run(h); }} className="card px-4 py-2 text-sm font-semibold">🕐 {h}</button>)}</div>
            </div>
          )}
          <h3 className="font-extrabold mb-2">Trending searches</h3>
          <div className="flex flex-wrap gap-2">{TRENDING.map(t => <button key={t} onClick={() => { setQ(t); setLoading(true); run(t); }} className="card px-4 py-2 text-sm font-semibold">🔥 {t}</button>)}</div>
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

      {!loading && q && tab === 'Songs' && (
        <div className="card p-2 mt-4 flex flex-col">{results.songs.map((t, i) => <SongRow key={t.id} track={t} index={i} context={results.songs} />)}
          {results.songs.length === 0 && <p className="p-4 text-sm text-dim">No songs found.</p>}</div>
      )}
      {!loading && q && tab === 'Albums' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">{results.albums.map(a => <AlbumCard key={a.id} album={a} />)}</div>
      )}
      {!loading && q && tab === 'Artists' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">{results.artists.map(a => <ArtistCard key={a.id} artist={a} />)}</div>
      )}
      {!loading && q && tab === 'Playlists' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">{results.playlists.map(p => <PlaylistCard key={p.id} playlist={p} />)}</div>
      )}
    </div>
  );
}
