import { useEffect, useState } from 'react';
import { api } from '../services/musicApi';
import { useStore } from '../store/useStore';
import { Img } from '../components/Cards';

const TAGS = ['All', 'rock', 'pop', 'jazz', 'classical', 'news', 'talk', 'electronic', 'hip hop', 'country', 'metal', 'reggae', 'sports', 'oldies', 'hindi'];
const COUNTRIES = ['', 'United States', 'United Kingdom', 'India', 'Germany', 'France', 'Canada', 'Australia', 'Japan'];

export default function Radio() {
  const [stations, setStations] = useState(null);
  const [tag, setTag] = useState('All');
  const [country, setCountry] = useState('');
  const [q, setQ] = useState('');
  const playTracks = useStore(s => s.playTracks);

  const load = async (params) => {
    setStations(null);
    try { setStations(await api.stations(params)); }
    catch { setStations([]); }
  };

  useEffect(() => {
    const params = {};
    if (tag !== 'All') params.tag = tag;
    if (country) params.country = country;
    load(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, country]);

  return (
    <div className="pb-8">
      <h1 className="text-2xl font-extrabold tracking-tight">📻 Live Radio</h1>
      <p className="text-sm text-dim">Thousands of real stations from around the world</p>

      <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) load({ name: q.trim() }); }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search stations…"
          className="flex-1 min-w-0 bg-soft border border-soft rounded-2xl px-5 py-2.5 text-sm outline-none font-semibold" aria-label="Search stations" />
        <button className="btn-accent px-5 text-sm">Search</button>
      </form>

      <div className="flex gap-1.5 mt-3 overflow-x-auto no-scrollbar pb-1">
        {TAGS.map(t => (
          <button key={t} onClick={() => setTag(t)} className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-bold capitalize ${tag === t ? 'bg-accent text-black' : 'bg-white/10'}`}>{t}</button>
        ))}
      </div>
      <div className="flex gap-1.5 mt-2 overflow-x-auto no-scrollbar pb-1">
        {COUNTRIES.map(c => (
          <button key={c || 'World'} onClick={() => setCountry(c)} className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-bold ${country === c ? 'bg-accent text-black' : 'bg-white/10'}`}>{c || '🌍 World'}</button>
        ))}
      </div>

      {!stations && <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton h-44 rounded-2xl" />)}</div>}
      {stations && stations.length === 0 && <p className="card p-4 mt-5 text-sm text-dim">No stations found. Try another genre or country.</p>}
      {stations && stations.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mt-5">
          {stations.map(s => (
            <button key={s.id} onClick={() => playTracks([s], 0)} className="card p-4 text-center">
              <span className="relative inline-block">
                <Img src={s.image} alt={s.title} className="w-20 h-20 rounded-full object-cover mx-auto bg-soft" />
                <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[9px] font-extrabold px-2 py-0.5 rounded-full bg-red-600 text-white sticker">● LIVE</span>
              </span>
              <p className="mt-2 truncate text-xs font-bold">{s.title}</p>
              <p className="truncate text-[10px] text-dim">{s.artist?.name}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
