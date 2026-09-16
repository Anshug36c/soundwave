import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../services/musicApi';
import { useStore } from '../store/useStore';
import { SongRow, AlbumCard, SkeletonList, Img } from '../components/Cards';
import { PlayIcon, CheckIcon, PlusIcon, ShuffleIcon, QueueIcon } from '../components/Icons';
import { shuffleList } from '../services/musicApi';

function shuffled(arr) {
  const x = [...(arr || [])];
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

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
    <div className="flex items-center gap-4 p-4 sm:gap-5 sm:p-6 hero-gradient rounded-2xl border border-soft flex-wrap">
      <Img src={image} alt={title} className={`w-28 h-28 sm:w-36 sm:h-36 object-cover shadow-2xl shrink-0 ${round ? 'rounded-full' : 'rounded-2xl'}`} />
      <div className="min-w-0">
        <p className="text-xs font-bold tracking-widest">{kicker}</p>
        <h1 className="text-2xl sm:text-3xl md:text-5xl font-extrabold tracking-tight">{title}</h1>
        {sub && <p className="text-sm text-dim mt-1">{sub}</p>}
        <div className="flex gap-2 mt-3 flex-wrap">
          {onPlay && <button onClick={onPlay} aria-label="Play" className="w-12 h-12 rounded-full btn-accent grid place-items-center shrink-0"><PlayIcon size={20} /></button>}
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
        extra={<button onClick={() => toggleSaveAlbum(data)} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10 inline-flex items-center gap-1.5">{saved ? <><CheckIcon size={15} />Saved</> : <><PlusIcon size={15} />Save</>}</button>} />
      <div className="panel p-2 mt-4 flex flex-col">
        {data.songs.map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.songs} />)}
      </div>
    </div>
  );
}

export function ArtistPage() {
  const { source, id, name } = useParams();
  const isAll = !!name; // :name only exists on the /artist/all/:name route
  const allName = isAll ? decodeURIComponent(name) : '';
  // declared BEFORE useLoad: the retry flow lists `reload` in its deps —
  // declaring it after was a TDZ crash (blank artist pages)
  const [reload, setReload] = useState(0);
  const { data, error } = useLoad(() => isAll
    ? api.artistSongs(allName).then(j => ({
        id: `all:ar:${allName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name: j.name || allName, image: j.songs?.[0]?.image || '',
        topSongs: j.songs || [], topAlbums: [], discogMeta: j,
      }))
    : api.artist(source, id), [source, id, name, reload]);
  const playTracks = useStore(s => s.playTracks);
  const addManyToQueue = useStore(s => s.addManyToQueue);
  const followedArtists = useStore(s => s.followedArtists);
  const toggleFollowArtist = useStore(s => s.toggleFollowArtist);
  const hiddenArtists = useStore(s => s.hiddenArtists);
  const hideArtist = useStore(s => s.hideArtist);
  const unhideArtist = useStore(s => s.unhideArtist);
  const [discog, setDiscog] = useState(null);
  const [discogLoading, setDiscogLoading] = useState(false);
  const [artCap, setArtCap] = useState(60);
  const [allAlbums, setAllAlbums] = useState(null);
  useEffect(() => { setArtCap(60); }, [data]);
  useEffect(() => {
    if (!isAll || !allName) return;
    api.search(allName, 'albums').then(r => setAllAlbums(r.albums || [])).catch(() => setAllAlbums([]));
  }, [isAll, allName]);
  const loadDiscog = () => {
    if (!data || discogLoading || (discog && !discog.partial)) return;
    setDiscogLoading(true);
    api.artistSongs(data.name).then(setDiscog).catch(() => setDiscog({ songs: [] })).finally(() => setDiscogLoading(false));
  };
  if (error) return <p className="p-8 text-center text-dim">{error}</p>;
  if (!data) return <SkeletonList />;
  const following = !!followedArtists[data.id];
  const isHidden = !!hiddenArtists[String(data.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')];
  const meta = isAll ? data.discogMeta : discog;
  const pp = meta?.perProvider;
  const provLine = pp ? ` · DJP ${pp.djp || 0} · DJJ ${pp.dj || 0} · MRJ ${pp.mrj || 0} · SVN ${pp.saavn || 0}` : '';
  const extra = discog ? (discog.songs || []).filter(t => !(data.topSongs || []).some(x => x.id === t.id)) : [];
  const shownTop = (data.topSongs || []).slice(0, isAll ? artCap : undefined);
  const shownAlbums = isAll ? allAlbums : data.topAlbums;
  return (
    <div className="pb-8">
      <Header image={data.image} round kicker={isAll ? 'ARTIST · ALL PROVIDERS' : 'ARTIST'} title={data.name}
        sub={(data.topSongs?.length || 0) + (isAll ? ' songs · full tracks' : ' top songs · full tracks') + (isAll ? provLine : '')}
        onPlay={data.topSongs?.length ? () => playTracks(data.topSongs, 0) : null}
        extra={<span className="flex gap-2 flex-wrap"><button onClick={() => toggleFollowArtist(data)} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10 inline-flex items-center gap-1.5">{following ? <><CheckIcon size={15} />Following</> : <><PlusIcon size={15} />Follow</>}</button><button onClick={() => isHidden ? unhideArtist(data.name) : hideArtist(data.name)} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10">{isHidden ? 'Unhide' : 'Hide'}</button><button onClick={() => data.topSongs?.length && playTracks(shuffleList(data.topSongs), 0)} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10 inline-flex items-center gap-1.5" aria-label="Shuffle artist"><ShuffleIcon size={15} />Shuffle</button><button onClick={() => addManyToQueue(data.topSongs)} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10 inline-flex items-center gap-1.5" aria-label="Add artist songs to queue"><QueueIcon size={15} />Queue</button></span>} />
      <h2 className="text-xl font-extrabold mt-6 mb-2">{isAll ? 'All Songs' : 'Top Songs'}</h2>
      <div className="panel p-2 flex flex-col">
        {shownTop.map((t, i) => <SongRow key={t.id} track={t} index={i} context={data.topSongs} />)}
        {(!data.topSongs || !data.topSongs.length) && <p className="p-4 text-sm text-dim">No songs found.</p>}
        {isAll && (data.topSongs || []).length > artCap && <button onClick={() => setArtCap(c => c + 60)} className="m-2 py-2.5 rounded-xl text-sm font-bold bg-white/10">Show more ({(data.topSongs || []).length - artCap} more)</button>}
      </div>
      {isAll && meta?.truncated && <p className="mt-2 text-xs text-dim font-semibold">Showing {(data.topSongs || []).length} of {meta.totalMatched} matched tracks across all providers.</p>}
      {isAll && meta?.partial && <button onClick={() => setReload(r => r + 1)} className="mt-2 text-xs font-bold text-green-500 underline">Some providers timed out — retry for the complete list</button>}
      {!isAll && (discog ? (<><h2 className="text-xl font-extrabold mt-6 mb-1">Complete discography</h2>
        <p className="text-xs text-dim font-semibold mb-2">Every provider combined{provLine}</p>
        <div className="panel p-2 flex flex-col">
          {extra.map((t, i) => <SongRow key={t.id} track={t} index={i} context={extra} />)}
          {extra.length === 0 && <p className="p-4 text-sm text-dim">No further tracks found beyond the top songs.</p>}
          {discog.partial && <button onClick={loadDiscog} disabled={discogLoading} className="m-2 text-xs font-bold text-green-500 underline disabled:opacity-60">{discogLoading ? 'Retrying…' : 'Some providers timed out — retry'}</button>}
        </div></>) : (
        <button onClick={loadDiscog} disabled={discogLoading}
          className="mt-6 w-full card p-4 text-left font-bold text-sm flex items-center justify-between gap-2 disabled:opacity-60">
          {discogLoading ? 'Gathering every track from all providers…' : 'Show complete discography — all providers'}<span aria-hidden>→</span>
        </button>
      ))}
      {(shownAlbums?.length > 0) && (<><h2 className="text-xl font-extrabold mt-6 mb-3">Albums</h2>
        <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">{shownAlbums.map(a => <AlbumCard key={a.id} album={a} />)}</div></>)}
    </div>
  );
}
