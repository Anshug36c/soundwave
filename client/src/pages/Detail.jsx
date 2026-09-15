import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../services/musicApi';
import { useStore } from '../store/useStore';
import { SongRow, AlbumCard, ArtistCard, SongCard, SkeletonList, Img } from '../components/Cards';

function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null); setError('');
    fn().then(setData).catch(e => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}

function Header({ image, round, kicker, title, sub, onPlay, extra }) {
  return (
    <div className="flex items-center gap-5 hero-gradient rounded-2xl p-6 border border-soft flex-wrap">
      <Img src={image} alt={title} className={`w-36 h-36 object-cover shadow-2xl shrink-0 ${round ? 'rounded-full' : 'rounded-2xl'}`} />
      <div className="min-w-0">
        <p className="text-xs font-bold tracking-widest">{kicker}</p>
        <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight">{title}</h1>
        {sub && <p className="text-sm text-dim mt-1">{sub}</p>}
        <div className="flex gap-2 mt-3 flex-wrap">
          {onPlay && <button onClick={onPlay} className="btn-accent px-6 py-2 text-sm">▶ Play</button>}
          {extra}
        </div>
      </div>
    </div>
  );
}

export function AlbumPage() {
  const { source, id } = useParams();
  const { data, error } = useLoad(() => api.album(source, id), [source, id]);
  const playTracks = useStore(s => s.playTracks);
  const savedAlbums = useStore(s => s.savedAlbums);
  const toggleSaveAlbum = useStore(s => s.toggleSaveAlbum);
  if (error) return <p className="p-8 text-center text-dim">{error}</p>;
  if (!data) return <SkeletonList />;
  const saved = !!savedAlbums[data.id];
  return (
    <div className="pb-8">
      <Header image={data.image} kicker="ALBUM" title={data.name} sub={`${data.artist} ${data.year ? `· ${data.year}` : ''} · ${data.songs.length} songs`}
        onPlay={() => playTracks(data.songs, 0)}
        extra={<button onClick={() => toggleSaveAlbum(data)} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10">{saved ? '✓ Saved' : '＋ Save'}</button>} />
      <div className="card p-2 mt-4 flex flex-col">
        {data.songs.map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.songs} />)}
      </div>
    </div>
  );
}

export function ArtistPage() {
  const { source, id } = useParams();
  const { data, error } = useLoad(() => api.artist(source, id), [source, id]);
  const playTracks = useStore(s => s.playTracks);
  const followedArtists = useStore(s => s.followedArtists);
  const toggleFollowArtist = useStore(s => s.toggleFollowArtist);
  const [radioLoading, setRadioLoading] = useState(false);
  if (error) return <p className="p-8 text-center text-dim">{error}</p>;
  if (!data) return <SkeletonList />;
  const following = !!followedArtists[data.id];
  const startRadio = async () => {
    setRadioLoading(true);
    try { const r = await api.radio(`${data.name} top songs`); if (r.songs?.length) playTracks(r.songs, 0); } catch {}
    setRadioLoading(false);
  };
  return (
    <div className="pb-8">
      <Header image={data.image} round kicker="ARTIST" title={data.name} sub={data.tags?.join(' · ')}
        onPlay={data.topSongs?.length ? () => playTracks(data.topSongs, 0) : null}
        extra={<><button onClick={() => toggleFollowArtist(data)} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10">{following ? '✓ Following' : '＋ Follow'}</button>
          <button onClick={startRadio} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10">{radioLoading ? '…' : '📻 Radio'}</button></>} />
      {data.bio && <p className="text-sm text-dim mt-4 leading-6 line-clamp-3">{data.bio}</p>}
      <h2 className="text-xl font-extrabold mt-6 mb-2">Top Songs</h2>
      <div className="card p-2 flex flex-col">
        {(data.topSongs || []).map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.topSongs} />)}
        {(!data.topSongs || !data.topSongs.length) && <p className="p-4 text-sm text-dim">No top songs found.</p>}
      </div>
      {(data.topAlbums?.length > 0) && (<><h2 className="text-xl font-extrabold mt-6 mb-3">Albums</h2>
        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">{data.topAlbums.map(a => <AlbumCard key={a.id} album={a} />)}</div></>)}
      {(data.similar?.length > 0) && (<><h2 className="text-xl font-extrabold mt-6 mb-3">Fans also like</h2>
        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">{data.similar.map(a => <ArtistCard key={a.id} artist={a} />)}</div></>)}
    </div>
  );
}

export function ExtPlaylistPage() {
  const { source, id } = useParams();
  const { data, error } = useLoad(() => api.playlist(source, id), [source, id]);
  const playTracks = useStore(s => s.playTracks);
  if (error) return <p className="p-8 text-center text-dim">{error}</p>;
  if (!data) return <SkeletonList />;
  return (
    <div className="pb-8">
      <Header image={data.image} kicker="PLAYLIST" title={data.name} sub={`${data.songs.length} songs`} onPlay={() => playTracks(data.songs, 0)} />
      {data.description && <p className="text-sm text-dim mt-3">{data.description.replace(/<[^>]*>/g, '').slice(0, 300)}</p>}
      <div className="card p-2 mt-4 flex flex-col">
        {data.songs.map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.songs} />)}
      </div>
    </div>
  );
}

export function ChartsPage() {
  const { data, error } = useLoad(() => api.charts(), []);
  const playTracks = useStore(s => s.playTracks);
  if (error) return <p className="p-8 text-center text-dim">{error}</p>;
  if (!data) return <div className="p-2"><SkeletonList /></div>;
  return (
    <div className="pb-8">
      <h1 className="text-2xl font-extrabold tracking-tight">📈 Global Charts</h1>
      <p className="text-sm text-dim">Top tracks, albums & artists right now</p>
      <div className="card p-2 mt-4 flex flex-col">
        {data.tracks.map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.tracks} />)}
      </div>
      <h2 className="text-xl font-extrabold mt-7 mb-3">Top Albums</h2>
      <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">{data.albums.map(a => <AlbumCard key={a.id} album={a} />)}</div>
      <h2 className="text-xl font-extrabold mt-7 mb-3">Top Artists</h2>
      <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">{data.artists.map(a => <ArtistCard key={a.id} artist={a} />)}</div>
      <h2 className="text-xl font-extrabold mt-7 mb-3">Trending Songs (tap to play)</h2>
      <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">{data.tracks.slice(0, 12).map(t => <SongCard key={t.id} track={t} context={data.tracks} />)}</div>
      <button onClick={() => playTracks(data.tracks, 0)} className="btn-accent px-6 py-2.5 text-sm mt-4">▶ Play Top 25</button>
    </div>
  );
}
