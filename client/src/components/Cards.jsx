import { memo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { PlayIcon, HeartIcon, PlusIcon, CloseIcon, NoteIcon, HideIcon, DotsIcon } from './Icons';
import { formatTime } from '../services/musicApi';

function Img_({ src, alt, className = '' }) {
  return (
    /* dataset.fb guards the fallback: if the icon itself ever fails (offline
       install), we don't loop on error events */
    <img src={src || '/icons/icon.svg'} alt={alt || ''} loading="lazy" decoding="async" onError={(e) => { const el = e.currentTarget; if (el.dataset.fb) return; el.dataset.fb = '1'; el.src = '/icons/icon.svg'; }} className={className} />
  );
}

const SRC_TAG = { djp: 'DJP', dj: 'DJJ', mrj: 'MRJ', saavn: 'SVN', yt: 'YT', audius: 'AUD' };
export function SourceBadge({ track }) {
  const tag = SRC_TAG[track?.source] ? `${SRC_TAG[track.source]} · ` : '';
  /* hidden on phones: on a 320-390px row the badge steals most of the artist
     line; the artist name wins there, the badge returns at >=400px */
  return <span className="hidden min-[400px]:inline-block text-[9px] font-bold px-1.5 py-[1px] rounded-[4px] whitespace-nowrap bg-[var(--surface-2)] text-dim align-middle">{tag}FULL</span>;
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
  const [more, setMore] = useState(false);
  const isCurrent = queue[idx]?.id === track.id;
  const isLiked = !!liked[track.id];
  const isDisliked = !!disliked[track.id];

  /* Phone layout: artwork leads, one like button inline, and a dots button
     that unfolds the secondary actions (queue / next / hide) below the row.
     ≥400px gets the fuller inline set instead. The current-track indicator
     lives by the title so it survives at every width. */
  return (
    <div className={`song-row group flex flex-col rounded-[var(--r-ui)] transition-colors duration-200 ${isCurrent ? 'bg-[var(--surface-3)]' : 'bg-hoverable active:bg-[var(--surface-2)]'}`}>
      <div className="flex items-center gap-2.5 px-2.5 sm:gap-3 sm:px-3 py-2">
        {showIndex && (
          <span className="hidden min-[400px]:grid w-6 shrink-0 place-items-center text-[13px] text-dim tabular-nums">
            <button onClick={() => playTrack(track, context)} aria-label={`Play ${track.title}`} className="grid h-6 w-6 place-items-center">
              <span className="group-hover:hidden inline-block">{index + 1}</span>
              <span className="hidden group-hover:inline-block" style={{ color: 'var(--text)' }}><PlayIcon size={12} /></span>
            </button>
          </span>
        )}
        <button onClick={() => playTrack(track, context)} className="relative shrink-0" aria-label={`Play ${track.title}`}>
          <Img src={track.image} alt="" className={`w-12 h-12 rounded-[8px] object-cover shadow-[var(--shadow-1)] ${isCurrent ? 'ring-2 ring-[var(--accent)]' : ''}`} />
          <span className="absolute inset-0 grid place-items-center bg-black/45 rounded-[8px] opacity-0 group-hover:opacity-100 text-white transition-opacity duration-200">▶</span>
        </button>
        <button onClick={() => playTrack(track, context)} className="min-w-0 flex-1 text-left">
          <span className={`flex min-w-0 items-center gap-1.5 ${isCurrent ? 'accent' : ''}`}>
            {isCurrent && isPlaying && <EqIcon />}
            <span className="truncate text-[14px] font-semibold leading-snug">{track.title}</span>
          </span>
          <span className="t-caption mt-0.5 flex min-w-0 items-center gap-1.5">
            <span className="truncate">{track.artist?.name}</span>
            <SourceBadge track={track} />
          </span>
        </button>
        <button onClick={() => toggleLike(track)} className={`btn-quiet shrink-0 px-2 active:scale-90 ${isLiked ? 'accent' : ''}`} aria-label={isLiked ? 'Unlike' : 'Like'}>
          <HeartIcon size={18} filled={isLiked} />
        </button>
        <button onClick={() => toggleDislike(track)} className={`btn-quiet hidden min-[400px]:grid shrink-0 place-items-center px-2 ${isDisliked ? 'text-red-400' : ''}`} aria-label="Dislike" title="Don't recommend this"><HideIcon size={18} /></button>
        {badge && <span className="hidden min-[400px]:block shrink-0 text-[12px] text-dim">{badge}</span>}
        <span className="hidden min-[360px]:block w-10 shrink-0 text-right text-[12px] text-dim tabular-nums">{formatTime(track.duration)}</span>
        <button onClick={() => playNext(track)} className="hidden min-[400px]:block px-2 py-2 text-[10px] font-bold text-dim transition-opacity hover:text-[var(--text)] md:opacity-0 md:group-hover:opacity-100" aria-label="Play next" title="Play next">NEXT</button>
        <button onClick={() => addToQueue(track)} className="btn-quiet hidden min-[400px]:grid shrink-0 place-items-center px-1.5" aria-label="Add to queue" title="Add to queue"><PlusIcon size={17} /></button>
        <button onClick={() => setMore(v => !v)} aria-label="More options" aria-expanded={more}
          className={`btn-quiet grid shrink-0 place-items-center min-[400px]:hidden ${more ? 'accent' : ''}`}>
          <DotsIcon size={18} />
        </button>
        {onMoveUp && <button onClick={onMoveUp} className="btn-quiet px-2 py-2 text-[10px]" aria-label="Move up">▲</button>}
        {onMoveDown && <button onClick={onMoveDown} className="btn-quiet px-2 py-2 text-[10px]" aria-label="Move down">▼</button>}
        {onRemove && <button onClick={onRemove} className="btn-quiet px-1 py-2" aria-label="Remove"><CloseIcon size={14} /></button>}
      </div>
      {more && (
        <div className="flex gap-2 px-3 pb-2.5 min-[400px]:hidden">
          <button onClick={() => addToQueue(track)} className="chip flex-1">Queue</button>
          <button onClick={() => playNext(track)} className="chip flex-1">Play next</button>
          <button onClick={() => toggleDislike(track)} className={`chip flex-1 ${isDisliked ? 'text-red-400' : ''}`}>{isDisliked ? 'Hidden' : 'Hide'}</button>
        </div>
      )}
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
    <div onClick={() => playTrack(track, context || [track])} className="media-card group relative cursor-pointer min-w-[152px] max-w-[190px] pb-1" role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playTrack(track, context || [track]); } }}>
      <div className="relative">
        <Img src={track.image} alt="" className="w-full aspect-square object-cover" />
        {/* touch has no hover: a persistent badge shows the card plays */}
        <span className="absolute bottom-2 right-2 w-9 h-9 rounded-full btn-accent grid place-items-center shadow-[var(--shadow-2)] md:hidden" aria-hidden="true"><PlayIcon size={15} /></span>
        <PlayButton onPlay={() => playTrack(track, context || [track])} />
      </div>
      {/* Title sits outside the artwork with no card behind it. */}
      <p className="mt-2.5 truncate text-[14px] font-semibold leading-snug">{track.title}</p>
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
        {href && <Link to={href} className="text-[13px] font-semibold accent py-2 -my-2 shrink-0">See All</Link>}
      </div>
      <div className="flex gap-4 overflow-x-auto no-scrollbar snap-x fade-r pb-2 px-1 [&>*]:snap-start">{children}</div>
    </section>
  );
}

export function SkeletonRow({ count = 6 }) {
  return (
    <div className="flex gap-3 overflow-hidden pb-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="min-w-[152px]"><div className="skeleton aspect-square rounded-lg" /><div className="skeleton h-3 rounded mt-2 w-3/4" /><div className="skeleton h-3 rounded mt-1 w-1/2" /></div>
      ))}
    </div>
  );
}

export function SkeletonList({ count = 6 }) {
  return <div className="flex flex-col gap-2">{Array.from({ length: count }).map((_, i) => <div key={i} className="skeleton h-16 rounded-lg" />)}</div>;
}

// Memoized: lists re-render only the rows whose props actually changed.
export const Img = memo(Img_);
export const SongRow = memo(SongRow_);
export const SongCard = memo(SongCard_);
export const AlbumCard = memo(AlbumCard_);
export const ArtistCard = memo(ArtistCard_);
