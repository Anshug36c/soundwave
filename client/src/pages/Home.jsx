import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, debounce, formatTime, tasteFiltered } from '../services/musicApi';
import { useStore } from '../store/useStore';
import { SongRow, SongCard, AlbumCard, ArtistCard, SectionRow, SkeletonRow, SkeletonList, Img } from '../components/Cards';

const MOODS = [
  { name: 'AP Dhillon', emoji: '🔥', q: 'ap dhillon' },
  { name: 'Diljit Dosanjh', emoji: '⭐', q: 'diljit dosanjh' },
  { name: 'Guru Randhawa', emoji: '🎤', q: 'guru randhawa' },
  { name: 'Jasmine Sandlas', emoji: '💃', q: 'jasmine sandlas' },
  { name: 'Tulsi Kumar', emoji: '❤️', q: 'tulsi kumar' },
  { name: 'Karan Aujla', emoji: '⚡', q: 'karan aujla' },
];

function ForYouRow({ track, context }) {
  const playTrack = useStore(s => s.playTrack);
  const queue = useStore(s => s.queue);
  const idx = useStore(s => s.index);
  const isCurrent = queue[idx]?.id === track.id;
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isCurrent ? 'bg-accent/10' : 'bg-hoverable'}`}>
      <button onClick={() => playTrack(track, context)} className="relative shrink-0" aria-label={`Play ${track.title}`}>
        <Img src={track.image} alt={track.title} className="w-11 h-11 rounded-md object-cover" />
      </button>
      <button onClick={() => playTrack(track, context)} className="flex-1 min-w-0 text-left">
        <p className="truncate text-sm font-semibold">{track.title}</p>
        <p className="truncate text-xs text-dim">{track.artist?.name}</p>
        {track.reason && <p className="truncate text-[11px] text-green-500 font-semibold">{track.reason}</p>}
      </button>
      <span className="text-xs text-dim w-10 text-right">{formatTime(track.duration)}</span>
    </div>
  );
}

export default function Home() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const history = useStore(s => s.history);
  const playTracks = useStore(s => s.playTracks);
  const discoverMix = useStore(s => s.discoverMix);
  const setDiscoverMix = useStore(s => s.setDiscoverMix);
  const disliked = useStore(s => s.disliked);
  const hiddenArtists = useStore(s => s.hiddenArtists);
  const [heroIdx, setHeroIdx] = useState(0);
  const [forYou, setForYou] = useState([]);
  const [forYouLoading, setForYouLoading] = useState(true);
  const [decade, setDecade] = useState('2000s');
  const [tm, setTm] = useState([]);
  const [tmLoading, setTmLoading] = useState(false);

  useEffect(() => {
    api.home().then(setData).catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    if (!data?.hero?.length) return;
    const t = setInterval(() => setHeroIdx(i => (i + 1) % data.hero.length), 5000);
    return () => clearInterval(t);
  }, [data]);

  const seeds = useMemo(() => {
    const seen = new Set(), out = [];
    for (const t of history) {
      if (!t?.title || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ t: t.title, a: t.artist?.name || '' });
      if (out.length >= 3) break;
    }
    return out;
  }, [history]);
  const topArtists = useMemo(() => {
    const c = {};
    for (const t of history) { const n = t.artist?.name; if (n && n !== 'Unknown') c[n] = (c[n] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);
  }, [history]);
  const seedsKey = seeds.map(s => s.t).join('|');
  const artistsKey = topArtists.join('|');

  const fetchForYou = useMemo(() => debounce((mix, sd, arts) => {
    setForYouLoading(true);
    api.forYou(mix, sd, arts).then(r => setForYou(r.songs || [])).catch(() => {}).finally(() => setForYouLoading(false));
  }, 500), []);
  useEffect(() => { fetchForYou(discoverMix, seeds, topArtists); }, [discoverMix, seedsKey, artistsKey]);
  useEffect(() => {
    setTmLoading(true);
    api.timeMachine(decade, topArtists).then(r => setTm(r.songs || [])).catch(() => {}).finally(() => setTmLoading(false));
  }, [decade, artistsKey]);

  if (error) return <div className="p-8 text-center"><p className="text-lg font-bold">Couldn't load music feed 😞</p><p className="text-sm text-dim">{error}</p><p className="text-sm text-dim mt-2">Is the backend running? <code>npm run dev:server</code></p></div>;
  if (!data) return <div className="p-4"><div className="skeleton h-56 rounded-2xl" /><div className="mt-6"><SkeletonRow /></div><div className="mt-6"><SkeletonList /></div></div>;

  const hero = data.hero[heroIdx];
  const visibleForYou = tasteFiltered(forYou, disliked, hiddenArtists);
  const visibleTm = tasteFiltered(tm, disliked, hiddenArtists);

  return (
    <div className="pb-8">
      {/* Hero carousel */}
      {hero && (
        <div className="relative rounded-2xl overflow-hidden hero-gradient border border-soft fade-up">
          <div className="absolute inset-0 bg-cover bg-center opacity-30 blur-xl scale-110" style={{ backgroundImage: `url(${hero.image})` }} />
          <div className="relative flex items-center gap-5 p-6">
            <Img src={hero.image} alt={hero.title} className="w-36 h-36 md:w-48 md:h-48 rounded-2xl object-cover shadow-2xl" />
            <div className="min-w-0">
              <p className="text-xs font-bold tracking-widest accent">FEATURED · LATEST DROP</p>
              <h1 className="text-2xl md:text-4xl font-extrabold tracking-tight truncate">{hero.title}</h1>
              <p className="text-dim font-semibold">{hero.artist?.name}</p>
              <div className="flex gap-2 mt-4">
                <button onClick={() => playTracks(data.newDrops, heroIdx % data.newDrops.length)} className="btn-accent px-6 py-2.5 text-sm">▶ Play</button>
                <button onClick={() => setHeroIdx((heroIdx + 1) % data.hero.length)} className="px-5 py-2.5 rounded-full text-sm font-bold bg-white/10">Next →</button>
              </div>
            </div>
          </div>
          <div className="relative flex gap-1.5 justify-center pb-3">
            {data.hero.map((_, i) => <button key={i} onClick={() => setHeroIdx(i)} aria-label={`Slide ${i + 1}`} className={`h-1.5 rounded-full transition-all ${i === heroIdx ? 'w-6 bg-accent' : 'w-1.5 bg-white/30'}`} />)}
          </div>
        </div>
      )}

      {/* Artist bubbles */}
      <div className="flex gap-2 mt-6 overflow-x-auto no-scrollbar pb-1">
        {MOODS.map(m => (
          <Link key={m.name} to={`/search?q=${encodeURIComponent(m.q)}`} className="card shrink-0 px-4 py-2.5 text-sm font-bold"> {m.emoji} {m.name}</Link>
        ))}
      </div>

      {history.length > 0 && (
        <SectionRow title="Recently Played" subtitle="Jump back in">
          {history.slice(0, 12).map(t => <SongCard key={t.id} track={t} context={history} />)}
        </SectionRow>
      )}

      {/* For You */}
      <section className="mt-7">
        <div className="flex items-center justify-between px-1 mb-1 flex-wrap gap-2">
          <div><h2 className="text-xl font-extrabold tracking-tight">For You</h2>
            <p className="text-xs text-dim font-semibold">Mixed from your recent plays{seeds[0] ? ` · latest: ${seeds[0].t}` : ''}</p></div>
          <label className="flex items-center gap-2 text-[11px] font-bold text-dim">Familiar
            <input type="range" min="0" max="100" value={discoverMix} onChange={e => setDiscoverMix(+e.target.value)}
              className="w-32 accent-green-500" aria-label="Discovery mix" />Adventurous</label>
        </div>
        <div className="card p-2 flex flex-col">
          {forYouLoading && <SkeletonList count={4} />}
          {!forYouLoading && visibleForYou.slice(0, 8).map((t, i) => <ForYouRow key={`${t.id}-${i}`} track={t} context={visibleForYou} />)}
          {!forYouLoading && !visibleForYou.length && <p className="p-4 text-sm text-dim">Play a few songs and this mix will tune itself to you.</p>}
        </div>
      </section>

      {/* Time Machine */}
      <section className="mt-7">
        <div className="flex items-center justify-between px-1 mb-3 flex-wrap gap-2">
          <h2 className="text-xl font-extrabold tracking-tight">🕰 Time Machine</h2>
          <div className="flex gap-1.5">{['80s', '90s', '2000s', '2010s', '2020s'].map(d => (
            <button key={d} onClick={() => setDecade(d)} className={`px-3 py-1 rounded-full text-xs font-bold ${decade === d ? 'bg-accent text-black' : 'bg-white/10'}`}>{d}</button>
          ))}</div>
        </div>
        <div className="card p-2 flex flex-col">
          {tmLoading && <SkeletonList count={4} />}
          {!tmLoading && visibleTm.slice(0, 8).map((t, i) => <ForYouRow key={`${t.id}-${i}`} track={t} context={visibleTm} />)}
          {!tmLoading && !visibleTm.length && <p className="p-4 text-sm text-dim">No {decade} tracks found for your artists — try another decade.</p>}
        </div>
      </section>

      {data.newDrops?.length > 0 && (
        <SectionRow title="🆕 New Drops" subtitle="Fresh off DJPunjab · full tracks">
          {data.newDrops.map(t => <SongCard key={t.id} track={t} context={data.newDrops} />)}
        </SectionRow>
      )}

      {data.trendingNow?.length > 0 && (
        <section className="mt-7">
          <h2 className="text-xl font-extrabold tracking-tight mb-3 px-1">Trending Now</h2>
          <div className="card p-2 flex flex-col">
            {data.trendingNow.slice(0, 10).map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.trendingNow} />)}
          </div>
        </section>
      )}

      {data.topArtists?.length > 0 && (
        <SectionRow title="Top Artists" subtitle="Most wanted voices">
          {data.topArtists.map(a => <ArtistCard key={a.id} artist={a} />)}
        </SectionRow>
      )}

      {data.newReleases?.length > 0 && (
        <SectionRow title="New Albums & EPs" subtitle="Latest releases">
          {data.newReleases.map(a => <AlbumCard key={a.id} album={a} />)}
        </SectionRow>
      )}

      <div className="grid md:grid-cols-2 gap-4 mt-7">
        {data.party?.length > 0 && (
          <div className="card p-3">
            <h3 className="font-extrabold mb-2">⚡ Party Energy</h3>
            {data.party.slice(0, 5).map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.party} />)}
          </div>
        )}
        {data.romantic?.length > 0 && (
          <div className="card p-3">
            <h3 className="font-extrabold mb-2">❤️ Romantic</h3>
            {data.romantic.slice(0, 5).map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.romantic} />)}
          </div>
        )}
      </div>
    </div>
  );
}
