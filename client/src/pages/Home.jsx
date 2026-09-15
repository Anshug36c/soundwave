import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/musicApi';
import { useStore } from '../store/useStore';
import { SongRow, SongCard, AlbumCard, ArtistCard, PlaylistCard, SectionRow, SkeletonRow, SkeletonList, Img } from '../components/Cards';

const MOODS = [
  { name: 'Happy', emoji: '😊', q: 'happy upbeat hits' },
  { name: 'Chill', emoji: '😌', q: 'chill lofi songs' },
  { name: 'Energetic', emoji: '⚡', q: 'energetic workout hits' },
  { name: 'Romantic', emoji: '❤️', q: 'romantic bollywood songs' },
  { name: 'Focus', emoji: '🎯', q: 'focus instrumental study' },
  { name: 'Party', emoji: '🎉', q: 'party dance hits' },
];

export default function Home() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const history = useStore(s => s.history);
  const playTracks = useStore(s => s.playTracks);
  const [heroIdx, setHeroIdx] = useState(0);
  const [ytmSongs, setYtmSongs] = useState(null);
  const [underground, setUnderground] = useState(null);
  const [stations, setStations] = useState(null);

  useEffect(() => {
    api.home().then(setData).catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    import('../services/ytmusic').then(m => m.ytTrending())
      .then(s => setYtmSongs(s))
      .catch(() => setYtmSongs([]));
    api.underground().then(setUnderground).catch(() => setUnderground([]));
    api.stations().then(setStations).catch(() => setStations([]));
  }, []);

  useEffect(() => {
    if (!data?.hero?.length) return;
    const t = setInterval(() => setHeroIdx(i => (i + 1) % data.hero.length), 5000);
    return () => clearInterval(t);
  }, [data]);

  if (error) return <div className="p-8 text-center"><p className="text-lg font-bold">Couldn't load music feed 😞</p><p className="text-sm text-dim">{error}</p><p className="text-sm text-dim mt-2">Is the backend running? <code>npm run dev:server</code></p></div>;
  if (!data) return <div className="p-4"><div className="skeleton h-56 rounded-2xl" /><div className="mt-6"><SkeletonRow /></div><div className="mt-6"><SkeletonList /></div></div>;

  const hero = data.hero[heroIdx];
  const madeForYou = [...(data.trendingNow || []), ...(data.charts || [])].slice(0, 12);

  return (
    <div className="pb-8">
      {/* Hero carousel */}
      {hero && (
        <div className="relative rounded-2xl overflow-hidden hero-gradient border border-soft fade-up">
          <div className="absolute inset-0 bg-cover bg-center opacity-30 blur-xl scale-110" style={{ backgroundImage: `url(${hero.image})` }} />
          <div className="relative flex items-center gap-5 p-6">
            <Img src={hero.image} alt={hero.title} className="w-36 h-36 md:w-48 md:h-48 rounded-2xl object-cover shadow-2xl" />
            <div className="min-w-0">
              <p className="text-xs font-bold tracking-widest accent">FEATURED · TRENDING NOW</p>
              <h1 className="text-2xl md:text-4xl font-extrabold tracking-tight truncate">{hero.title}</h1>
              <p className="text-dim font-semibold">{hero.artist?.name}</p>
              <div className="flex gap-2 mt-4">
                <button onClick={() => playTracks(data.trendingNow, heroIdx % data.trendingNow.length)} className="btn-accent px-6 py-2.5 text-sm">▶ Play</button>
                <button onClick={() => setHeroIdx((heroIdx + 1) % data.hero.length)} className="px-5 py-2.5 rounded-full text-sm font-bold bg-white/10">Next →</button>
              </div>
            </div>
          </div>
          <div className="relative flex gap-1.5 justify-center pb-3">
            {data.hero.map((_, i) => <button key={i} onClick={() => setHeroIdx(i)} aria-label={`Slide ${i + 1}`} className={`h-1.5 rounded-full transition-all ${i === heroIdx ? 'w-6 bg-accent' : 'w-1.5 bg-white/30'}`} />)}
          </div>
        </div>
      )}

      {/* Mood bubbles */}
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

      <SectionRow title="Made For You" subtitle="Based on trending + charts">
        {madeForYou.map(t => <SongCard key={t.id} track={t} context={madeForYou} />)}
      </SectionRow>

      <section className="mt-7">
        <h2 className="text-xl font-extrabold tracking-tight mb-3 px-1">Trending Now</h2>
        <div className="card p-2 flex flex-col">
          {data.trendingNow.slice(0, 10).map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.trendingNow} />)}
        </div>
      </section>

      {ytmSongs && ytmSongs.length > 0 && (
        <SectionRow title="▶ YouTube Music" subtitle="Full tracks · Opus quality · plays in your browser">
          {ytmSongs.map(t => <SongCard key={t.id} track={t} context={ytmSongs} />)}
        </SectionRow>
      )}

      {underground && underground.length > 0 && (
        <SectionRow title="🔥 Underground" subtitle="Full tracks · fresh indie artists on Audius">
          {underground.map(t => <SongCard key={t.id} track={t} context={underground} />)}
        </SectionRow>
      )}

      {stations && stations.length > 0 && (
        <section className="mt-7">
          <div className="mb-3 px-1">
            <h2 className="text-xl font-extrabold tracking-tight">📻 Live Radio</h2>
            <p className="text-xs text-dim">Real stations streaming now</p>
          </div>
          <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2 px-1">
            {stations.map(s => (
              <button key={s.id} onClick={() => playTracks([s], 0)} className="card shrink-0 w-36 p-3 text-center">
                <span className="relative inline-block">
                  <Img src={s.image} alt={s.title} className="w-20 h-20 rounded-full object-cover mx-auto bg-soft" />
                  <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[9px] font-extrabold px-2 py-0.5 rounded-full bg-red-600 text-white sticker">● LIVE</span>
                </span>
                <p className="mt-2 truncate text-xs font-bold">{s.title}</p>
                <p className="truncate text-[10px] text-dim">{s.artist?.name}</p>
              </button>
            ))}
          </div>
        </section>
      )}

      <SectionRow title="Top Artists" subtitle="Most streamed voices">
        {data.topArtists.map(a => <ArtistCard key={a.id} artist={a} />)}
      </SectionRow>

      <SectionRow title="New Releases" subtitle="Fresh albums">
        {data.newReleases.map(a => <AlbumCard key={a.id} album={a} />)}
      </SectionRow>

      <SectionRow title="Global Charts" subtitle="Deezer Top 20">
        {data.charts.map(t => <SongCard key={t.id} track={t} context={data.charts} />)}
      </SectionRow>

      <div className="grid md:grid-cols-2 gap-4 mt-7">
        <div className="card p-3">
          <h3 className="font-extrabold mb-2">😌 Chill Zone</h3>
          {data.mood.chill.slice(0, 5).map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.mood.chill} />)}
        </div>
        <div className="card p-3">
          <h3 className="font-extrabold mb-2">⚡ Workout Energy</h3>
          {data.mood.workout.slice(0, 5).map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.mood.workout} />)}
        </div>
      </div>

      {data.featuredPlaylists?.length > 0 && (
        <SectionRow title="Featured Playlists">
          {data.featuredPlaylists.map(p => <PlaylistCard key={p.id} playlist={p} />)}
        </SectionRow>
      )}
    </div>
  );
}
