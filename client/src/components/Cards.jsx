import { memo } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { PlayIcon, HeartIcon, PlusIcon, CloseIcon, NoteIcon, HideIcon } from './Icons';
import { formatTime } from '../services/musicApi';

function Img_({ src, alt, className = '' }) {
  return (
    <img src={src || '/icons/icon.svg'} alt={alt || ''} loading="lazy" decoding="async" onError={(e) => { e.currentTarget.src = '/icons/icon.svg'; }} className={className} />
  );
}

const SRC_TAG = { djp: 'DJP', dj: 'DJJ', mrj: 'MRJ', saavn: 'SVN', yt: 'YT' };
export function SourceBadge({ track }) {
  const tag = SRC_TAG[track?.source] ? `${SRC_TAG[track.source]} · ` : '';
  return <span className="sticker ml-1.5 text-[9px] font-bold px-1.5 py-[1px] rounded-[4px] whitespace-nowrap bg-[var(--surface-2)] text-dim align-middle">{tag}FULL</span>;
}

function SongRow_({ track, index, context, showIndex = true, onRemove, onMoveUp, onMoveDown, badge }) {
  const playTrack = useStore(s => s.playTrack);
  const playNext = useStore(s => s.playNext);
  const queue = useStore(s => s.queue);
  const idx = useStore(s => s.index);
  const isPlaying = useStore(s => s.isPlaying);
  const liked = useStore(s => s.liked);
  const toggleLike = useStore(s => s.toggleLike);
  const toggleDislike = useStore(s => s.toggleDislike);
  const disliked = useStore(s => s.disliked);
  const addToQueue = useStore(s => s.addToQueue);
  const isCurrent = queue[idx]?.id === track.id;
  const isLiked = !!liked[track.id];
  const isDisliked = !!disliked[track.id];

  return (
    <div className={`group flex items-center gap-2.5 px-3 sm:gap-3 py-2 rounded-[var(--r-ui)] transition-colors duration-200 ${isCurrent ? 'bg-[var(--surface-3)]' : 'bg-hoverable hover:bg-[var(--surface-2)]'}`} role="row">
      <span className="w-6 text-center text-[13px] text-dim shrink-0 tabular-nums">
        {isCurrent && isPlaying ? <EqIcon /> : (
          <button onClick={() => playTrack(track, context)} aria-label={`Play ${track.title}`}>
            <span className="group-hover:hidden inline-block">{showIndex ? index + 1 : <NoteIcon size={14} />}</span>
            <span className="hidden group-hover:inline-block" style={{ color: 'var(--text)' }}><PlayIcon size={12} /></span>
          </button>
        )}
      </span>
      <button onClick={() => playTrack(track, context)} className="relative shrink-0" aria-label={`Play ${track.title}`}>
        <Img src={track.image} alt={track.title} className="w-10 h-10 sm:w-11 sm:h-11 rounded-[7px] object-cover shadow-[var(--shadow-1)]" />
        <span className="absolute inset-0 grid place-items-center bg-black/45 rounded-[7px] opacity-0 group-hover:opacity-100 text-white transition-opacity duration-200">▶</span>
      </button>
      <button onClick={() => playTrack(track, context)} className="flex-1 min-w-0 text-left">
        <p className={`truncate text-[14px] font-semibold ${isCurrent ? 'accent' : ''}`}>{track.title}</p>
        <p className="truncate t-caption flex items-center">{track.artist?.name} <SourceBadge track={track} /></p>
      </button>
      <button onClick={() => toggleLike(track)} className={`btn-quiet px-2.5 py-2 active:scale-90 ${isLiked ? 'accent' : 'md:opacity-0 md:group-hover:opacity-100'}`} aria-label="Like"><HeartIcon size={17} filled={isLiked} /></button>
      <button onClick={() => toggleDislike(track)} className={`px-2.5 py-2 transition-all active:scale-90 rounded-full ${isDisliked ? 'text-red-400' : 'text-dim md:opacity-0 md:group-hover:opacity-100 hover:text-[var(--text)]'}`} aria-label="Dislike" title="Don't recommend this"><HideIcon size={17} /></button>
      {badge && <span className="hidden min-[400px]:block text-[12px] text-dim shrink-0">{badge}</span>}
      <span className="hidden min-[400px]:block text-[12px] text-dim w-10 text-right shrink-0 tabular-nums">{formatTime(track.duration)}</span>
      <button onClick={() => playNext(track)} className="hidden min-[400px]:block text-dim px-2 py-2 md:opacity-0 md:group-hover:opacity-100 transition-opacity text-[10px] font-bold hover:text-[var(--text)]" aria-label="Play next" title="Play next">NEXT</button>
      <button onClick={() => addToQueue(track)} className="btn-quiet hidden min-[400px]:block px-1.5 py-1 md:opacity-0 md:group-hover:opacity-100" aria-label="Add to queue" title="Add to queue"><PlusIcon size={17} /></button>
      {onMoveUp && <button onClick={onMoveUp} className="btn-quiet px-2 py-2 text-[10px]" aria-label="Move up">▲</button>}
      {onMoveDown && <button onClick={onMoveDown} className="btn-quiet px-2 py-2 text-[10px]" aria-label="Move down">▼</button>}
      {onRemove && <button onClick={onRemove} className="btn-quiet px-1 py-2" aria-label="Remove"><CloseIcon size={14} /></button>}
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
      className="absolute bottom-2 right-2 w-11 h-11 rounded-full btn-accent grid place-items-center text-lg opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all shadow-xl" aria-label="Play"><PlayIcon size={18} /></button>
  );
}

function SongCard_({ track, context }) {
  const playTrack = useStore(s => s.playTrack);
  return (
    <div onClick={() => playTrack(track, context || [track])} className="media-card group relative cursor-pointer min-w-[152px] max-w-[190px] pb-1" role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && playTrack(track, context || [track])}>
      <div className="relative">
        <Img src={track.image} alt={track.title} className="w-full aspect-square object-cover" />
        <PlayButton onPlay={() => playTrack(track, context || [track])} />
      </div>
      {/* Title sits outside the artwork with no card behind it. */}
      <p className="mt-2.5 truncate text-[14px] font-semibold">{track.title}</p>
      <p className="t-caption truncate">{track.artist?.name}</p>
    </div>
  );
}

function AlbumCard_({ album }) {
  const [source, kind, ...rest] = String(album.id).split(':');
  const to = `/album/${source}/${rest.join(':') || kind}`;
  return (
    <Link to={to} className="media-card group relative min-w-[152px] max-w-[190px] pb-1">
      <Img src={album.image} alt={album.name} className="w-full aspect-square object-cover" />
      <p className="mt-2.5 truncate text-[14px] font-semibold">{album.name}</p>
      <p className="t-caption truncate">{album.artist}{album.year ? ` · ${album.year}` : ''}</p>
    </Link>
  );
}

function ArtistCard_({ artist }) {
  const [source, kind, ...rest] = String(artist.id).split(':');
  const to = `/artist/${source}/${rest.join(':') || kind}`;
  return (
    <Link to={to} className="media-card group min-w-[140px] max-w-[170px] text-center pb-1">
      <Img src={artist.image} alt={artist.name} className="w-full aspect-square rounded-full object-cover" />
      <p className="mt-2.5 truncate text-[14px] font-semibold">{artist.name}</p>
      <p className="t-caption">Artist</p>
    </Link>
  );
}

export function PlaylistCard({ playlist, to }) {
  let link = to;
  if (!link && playlist.id) {
    const [source, kind, ...rest] = String(playlist.id).split(':');
    link = `/playlist/${encodeURIComponent(playlist.id)}`;
  }
  const mosaic = playlist.tracks?.slice(0, 4) || [];
  return (
    <Link to={link} className="media-card group min-w-[152px] max-w-[190px] pb-1">
      {mosaic.length >= 4 ? (
        <div className="grid grid-cols-2 gap-[2px] overflow-hidden aspect-square rounded-[var(--r-art)] shadow-[var(--shadow-2)]">
          {mosaic.map(t => <Img key={t.id} src={t.image} alt="" className="w-full h-full object-cover" />)}
        </div>
      ) : (
        <Img src={playlist.image} alt={playlist.name} className="w-full aspect-square object-cover" />
      )}
      <p className="mt-2.5 truncate text-[14px] font-semibold">{playlist.name}</p>
      <p className="t-caption truncate">{playlist.tracks ? `${playlist.tracks.length} songs` : `${playlist.songCount || ''} songs`}</p>
    </Link>
  );
}

export function SectionRow({ title, subtitle, children, href }) {
  return (
    <section className="mt-8 first:mt-4">
      <div className="flex items-end justify-between mb-3 px-1 gap-4">
        <div className="min-w-0">
          <h2 className="h-section truncate">{title}</h2>
          {subtitle && <p className="t-caption mt-0.5 truncate">{subtitle}</p>}
        </div>
        {href && <Link to={href} className="text-[13px] font-semibold accent hover:opacity-75 transition-opacity shrink-0">See All</Link>}
      </div>
      <div className="flex gap-4 overflow-x-auto no-scrollbar snap-x pb-2 px-1 [&>*]:snap-start">{children}</div>
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

// Memoized: lists re-render only the rows whose props actually changed.
export const Img = memo(Img_);
export const SongRow = memo(SongRow_);
export const SongCard = memo(SongCard_);
export const AlbumCard = memo(AlbumCard_);
export const ArtistCard = memo(ArtistCard_);
