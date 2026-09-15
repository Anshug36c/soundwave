import { useEffect, useMemo, useState } from 'react';
import { api, debounce, formatTime } from '../services/musicApi';
import { useStore } from '../store/useStore';
import { Img, SkeletonList } from '../components/Cards';

function ShowCard({ show, onOpen }) {
  return (
    <button onClick={onOpen} className="card shrink-0 w-40 p-3 text-center">
      <Img src={show.image} alt={show.name} className="w-28 h-28 rounded-2xl object-cover mx-auto" />
      <p className="mt-2 truncate text-xs font-bold">{show.name}</p>
      <p className="truncate text-[10px] text-dim">{show.artist}</p>
    </button>
  );
}

export default function Podcasts() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [top, setTop] = useState(null);
  const [show, setShow] = useState(null);
  const [eps, setEps] = useState(null);
  const playTracks = useStore(s => s.playTracks);

  useEffect(() => { api.podcastTop().then(setTop).catch(() => setTop([])); }, []);

  const run = useMemo(() => debounce(async (query) => {
    if (!query.trim()) { setResults(null); return; }
    try { setResults(await api.podcasts(query.trim())); } catch { /* keep old */ }
  }, 400), []);

  const openShow = async (p) => {
    setShow(p); setEps(null);
    try {
      const r = await api.episodes(p.feedUrl, p.image, p.name);
      setEps(r.episodes || []);
    } catch { setEps([]); }
  };

  if (show) {
    return (
      <div className="pb-8">
        <button onClick={() => { setShow(null); setEps(null); }} className="text-sm font-bold text-dim mb-3">← All podcasts</button>
        <div className="flex items-center gap-4 hero-gradient rounded-2xl p-5 border border-soft flex-wrap">
          <Img src={show.image} alt={show.name} className="w-32 h-32 rounded-2xl object-cover shadow-2xl" />
          <div className="min-w-0">
            <p className="text-xs font-bold tracking-widest">PODCAST</p>
            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">{show.name}</h1>
            <p className="text-sm text-dim">{show.artist}</p>
            {eps && eps.length > 0 && <button onClick={() => playTracks(eps, 0)} className="btn-accent px-6 py-2 text-sm mt-3">▶ Play latest</button>}
          </div>
        </div>
        {!eps && <div className="mt-4"><SkeletonList /></div>}
        {eps && eps.length === 0 && <p className="card p-4 mt-4 text-sm text-dim">No playable episodes in this feed.</p>}
        {eps && eps.length > 0 && (
          <div className="card p-2 mt-4 flex flex-col">
            {eps.map((t, i) => (
              <div key={t.id} className="flex items-center gap-3 p-2 rounded-lg bg-hoverable">
                <button onClick={() => playTracks(eps, i)} className="w-10 h-10 rounded-full btn-accent grid place-items-center shrink-0" aria-label={`Play ${t.title}`}>▶</button>
                <button onClick={() => playTracks(eps, i)} className="flex-1 min-w-0 text-left">
                  <p className="truncate text-sm font-bold">{t.title}</p>
                  <p className="truncate text-xs text-dim">{t.pubDate ? new Date(t.pubDate).toLocaleDateString() : ''} {t.duration ? `· ${formatTime(t.duration)}` : ''}</p>
                  {t.description && <p className="truncate text-xs text-dim opacity-70">{t.description}</p>}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="pb-8">
      <h1 className="text-2xl font-extrabold tracking-tight">🎙️ Podcasts</h1>
      <p className="text-sm text-dim">Full episodes, free forever</p>
      <input value={q} onChange={e => { setQ(e.target.value); run(e.target.value); }}
        placeholder="Search podcasts…" className="w-full mt-4 bg-soft border border-soft rounded-2xl px-5 py-3 text-base outline-none font-semibold" aria-label="Search podcasts" />
      {results && (
        <section className="mt-6">
          <h2 className="text-xl font-extrabold mb-3">Results for “{q}”</h2>
          {results.length === 0 && <p className="text-sm text-dim">No podcasts found.</p>}
          <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
            {results.map(p => <ShowCard key={p.id} show={p} onOpen={() => openShow(p)} />)}
          </div>
        </section>
      )}
      <section className="mt-6">
        <h2 className="text-xl font-extrabold mb-3">🔥 Top Podcasts</h2>
        {!top && <div className="skeleton h-40 rounded-2xl" />}
        {top && <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">
          {top.map(p => <ShowCard key={p.id} show={p} onOpen={() => openShow(p)} />)}
        </div>}
      </section>
    </div>
  );
}
