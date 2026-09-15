import { Link } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { formatTime } from '../services/musicApi';

export function Img({ src, alt, className = '' }) {
  return (
    <img src={src || '/icons/icon.svg'} alt={alt || ''} loading="lazy" onError={(e) => { e.currentTarget.src = '/icons/icon.svg'; }} className={className} />
  );
}

export function SongRow({ track, index, context, showIndex = true, onRemove }) {
  const playTrack = useStore(s => s.playTrack);
  const queue = useStore(s => s.queue);
  const idx = useStore(s => s.index);
  const isPlaying = useStore(s => s.isPlaying);
  const liked = useStore(s => s.liked);
  const toggleLike = useStore(s => s.toggleLike);
  const addToQueue = useStore(s => s.addToQueue);
  const isCurrent = queue[idx]?.id === track.id;
  const isLiked = !!liked[track.id];

  return (
    <div className={`group flex items-center gap-3 px-3 py-2 rounded-lg ${isCurrent ? 'bg-accent/10' : 'bg-hoverable'}`} role="row">
      <span className="w-6 text-center text-sm text-dim">{showIndex ? (isCurrent && isPlaying ? <EqIcon /> : (index + 1)) : (isCurrent && isPlaying ? <EqIcon /> : '♪')}</span>
      <button onClick={() => playTrack(track, context)} className="relative shrink-0" aria-label={`Play ${track.title}`}>
        <Img src={track.image || track.thumbnails?.medium} alt={track.title} className="w-11 h-11 rounded-md object-cover" />
        <span className="absolute inset-0 grid place-items-center bg-black/50 rounded-md opacity-0 group-hover:opacity-100 text-white">▶</span>
      </button>
      <button onClick={() => playTrack(track, context)} className="flex-1 min-w-0 text-left">
        <p className={`truncate text-sm font-semibold ${isCurrent ? 'accent' : ''}`}>{track.title}</p>
        <p className="truncate text-xs text-dim">{track.artist?.name}{track.isPreview ? ' · preview' : ''}</p>
      </button>
      <button onClick={() => toggleLike(track)} className={`text-lg px-1 ${isLiked ? 'text-green-500' : 'opacity-0 group-hover:opacity-100 text-dim'}`} aria-label="Like">{isLiked ? '♥' : '♡'}</button>
      <span className="text-xs text-dim w-10 text-right">{formatTime(track.duration)}</span>
      <button onClick={() => addToQueue(track)} className="text-dim opacity-0 group-hover:opacity-100 px-1" aria-label="Add to queue" title="Add to queue">⏭＋</button>
      {onRemove && <button onClick={onRemove} className="text-dim px-1" aria-label="Remove">✕</button>}
    </div>
  );
}

export function EqIcon() {
  return (
    <span className="inline-flex items-end gap-[2px] h-4" aria-hidden>
      {[0, 1, 2].map(i => <span key={i} className="eq-bar w-[3px] h-4 bg-accent rounded" style={{ animationDelay: `${i * 0.2}s` }} />)}
    </span>
  );
}

function PlayButton({ onPlay }) {
  return (
    <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPlay(); }}
      className="absolute bottom-2 right-2 w-11 h-11 rounded-full btn-accent grid place-items-center text-lg opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all shadow-xl" aria-label="Play">▶</button>
  );
}

export function SongCard({ track, context }) {
  const playTrack = useStore(s => s.playTrack);
  return (
    <div onClick={() => playTrack(track, context || [track])} className="card group relative p-3 cursor-pointer min-w-[150px] max-w-[190px]" role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && playTrack(track, context || [track])}>
      <div className="relative">
        <Img src={track.image || track.thumbnails?.medium} alt={track.title} className="w-full aspect-square rounded-lg object-cover" />
        <PlayButton onPlay={() => playTrack(track, context || [track])} />
      </div>
      <p className="mt-2 truncate text-sm font-bold">{track.title}</p>
      <p className="truncate text-xs text-dim">{track.artist?.name}</p>
    </div>
  );
}

export function AlbumCard({ album }) {
  const [source, kind, ...rest] = String(album.id).split(':');
  const to = `/album/${source}/${rest.join(':') || kind}`;
  return (
    <Link to={to} className="card group relative p-3 min-w-[150px] max-w-[190px]">
      <Img src={album.image} alt={album.name} className="w-full aspect-square rounded-lg object-cover" />
      <p className="mt-2 truncate text-sm font-bold">{album.name}</p>
      <p className="truncate text-xs text-dim">{album.artist}{album.year ? ` · ${album.year}` : ''}</p>
    </Link>
  );
}

export function ArtistCard({ artist }) {
  const [source, kind, ...rest] = String(artist.id).split(':');
  const to = source === 'lastfm' ? `/search?q=${encodeURIComponent(artist.name)}` : `/artist/${source}/${rest.join(':') || kind}`;
  return (
    <Link to={to} className="card group p-3 min-w-[140px] max-w-[170px] text-center">
      <Img src={artist.image} alt={artist.name} className="w-full aspect-square rounded-full object-cover" />
      <p className="mt-2 truncate text-sm font-bold">{artist.name}</p>
      <p className="text-xs text-dim">Artist</p>
    </Link>
  );
}

export function PlaylistCard({ playlist, to }) {
  let link = to;
  if (!link && playlist.id) {
    const [source, kind, ...rest] = String(playlist.id).split(':');
    link = source === 'local' ? `/playlist/${encodeURIComponent(playlist.id)}` : `/ext-playlist/${source}/${rest.join(':') || kind}`;
  }
  const mosaic = playlist.tracks?.slice(0, 4) || [];
  return (
    <Link to={link} className="card group p-3 min-w-[150px] max-w-[190px]">
      {mosaic.length >= 4 ? (
        <div className="grid grid-cols-2 gap-[2px] rounded-lg overflow-hidden aspect-square">
          {mosaic.map(t => <Img key={t.id} src={t.image || t.thumbnails?.small} alt="" className="w-full h-full object-cover" />)}
        </div>
      ) : (
        <Img src={playlist.image} alt={playlist.name} className="w-full aspect-square rounded-lg object-cover" />
      )}
      <p className="mt-2 truncate text-sm font-bold">{playlist.name}</p>
      <p className="truncate text-xs text-dim">{playlist.tracks ? `${playlist.tracks.length} songs` : `${playlist.songCount || ''} songs`}</p>
    </Link>
  );
}

export function SectionRow({ title, subtitle, children, href }) {
  return (
    <section className="mt-7">
      <div className="flex items-end justify-between mb-3 px-1">
        <div>
          <h2 className="text-xl font-extrabold tracking-tight">{title}</h2>
          {subtitle && <p className="text-xs text-dim">{subtitle}</p>}
        </div>
        {href && <Link to={href} className="text-xs font-bold text-dim hover:text-white">SEE ALL</Link>}
      </div>
      <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2 px-1">{children}</div>
    </section>
  );
}

export function SkeletonRow({ count = 6 }) {
  return (
    <div className="flex gap-3 overflow-hidden pb-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="min-w-[160px]"><div className="skeleton aspect-square rounded-lg" /><div className="skeleton h-3 rounded mt-2 w-3/4" /><div className="skeleton h-3 rounded mt-1 w-1/2" /></div>
      ))}
    </div>
  );
}

export function SkeletonList({ count = 6 }) {
  return <div className="flex flex-col gap-2">{Array.from({ length: count }).map((_, i) => <div key={i} className="skeleton h-14 rounded-lg" />)}</div>;
}
