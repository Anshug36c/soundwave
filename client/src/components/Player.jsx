import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { api, formatTime, isYouTubeTrack } from '../services/musicApi';
import { setYouTubeHost } from '../services/ytPlayer';
import { seekTo } from '../hooks/useAudioEngine';
import { Img, EqIcon } from './Cards';
import { SimilarSongs } from './SimilarSongs';
import Equalizer from './Equalizer';
import Visualizer from './Visualizer';
import {
  PlayIcon, PauseIcon, NextIcon, PrevIcon, ShuffleIcon, RepeatIcon, RepeatOneIcon,
  VolumeIcon, MuteIcon, QueueIcon, ChevronDownIcon, ExpandIcon, MoonIcon,
  DownloadIcon, ShareIcon, HeartIcon, PlusIcon, NoteIcon, CloseIcon, CheckIcon, MicIcon,
  RefreshIcon,
} from './Icons';

function SpinIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* Spotify-style seek bar: light fill, green + knob on hover */
function ProgressBar({ currentTime, duration }) {
  const pct = duration ? Math.min(100, (currentTime / duration) * 100) : 0;
  const [showRem, setShowRem] = useState(false);
  const barRef = useRef(null);
  const scrub = (clientX) => {
    const bar = barRef.current;
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    const p = Math.min(Math.max((clientX - r.left) / r.width, 0), 1);
    seekTo(p * (duration || 0));
  };
  return (
    <div className="flex items-center gap-2 w-full">
      <span className="text-xs text-dim w-10 text-right tabular-nums">{formatTime(currentTime)}</span>
      <div ref={barRef}
        onPointerDown={e => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ } scrub(e.clientX); }}
        onPointerMove={e => { if (e.buttons & 1) scrub(e.clientX); }}
        className="sp-progress relative flex-1 h-6 flex items-center touch-none" role="slider"
        aria-label="Seek" aria-valuenow={Math.round(currentTime)} aria-valuemax={Math.round(duration || 0)} tabIndex={0}
        onKeyDown={e => {
          if (e.key === 'ArrowRight') seekTo(currentTime + 5);
          if (e.key === 'ArrowLeft') seekTo(currentTime - 5);
        }}>
        <div className="sp-track w-full h-1 rounded-full">
          <div className="sp-fill h-full rounded-full relative" style={{ width: `${pct}%` }}>
            <div className="sp-knob absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3 rounded-full" />
          </div>
        </div>
      </div>
      <button onClick={() => setShowRem(v => !v)} className="text-xs text-dim w-10 h-11 flex items-center tabular-nums text-left" aria-label="Toggle remaining time" title="Elapsed / remaining">{showRem && duration ? `-${formatTime(Math.max(0, duration - currentTime))}` : formatTime(duration)}</button>
    </div>
  );
}

export function MiniPlayer() {
  const swipeX = useRef(null);
  const miniBarRef = useRef(null); // scrubbable progress strip on the bar
  const queue = useStore(s => s.queue);
  const index = useStore(s => s.index);
  const isPlaying = useStore(s => s.isPlaying);
  const togglePlay = useStore(s => s.togglePlay);
  const next = useStore(s => s.next);
  const prev = useStore(s => s.prev);
  const buffering = useStore(s => s.buffering);
  const currentTime = useStore(s => s.currentTime);
  const duration = useStore(s => s.duration);
  const setShowFullPlayer = useStore(s => s.setShowFullPlayer);
  const setShowQueue = useStore(s => s.setShowQueue);
  const shuffle = useStore(s => s.shuffle);
  const repeat = useStore(s => s.repeat);
  const toggleShuffle = useStore(s => s.toggleShuffle);
  const cycleRepeat = useStore(s => s.cycleRepeat);
  const volume = useStore(s => s.volume);
  const muted = useStore(s => s.muted);
  const setVolume = useStore(s => s.setVolume);
  const setMuted = useStore(s => s.setMuted);
  const liked = useStore(s => s.liked);
  const toggleLike = useStore(s => s.toggleLike);
  const playError = useStore(s => s.playError);
  const track = index >= 0 ? queue[index] : null;

  if (!track) return null;
  const pct = duration ? (currentTime / duration) * 100 : 0;
  const isLiked = !!liked[track.id];
  // reached the end of the last track: offer a replay instead of a dead Play
  const ended = !isPlaying && !buffering && duration > 0 && currentTime >= duration - 0.5;
  const onPlayBtn = () => { if (ended) seekTo(0); togglePlay(); };
  const miniScrub = (x) => {
    const bar = miniBarRef.current;
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    const p = Math.min(Math.max((x - r.left) / r.width, 0), 1);
    seekTo(p * (duration || 0));
  };

  return (
    <div className="fixed left-0 right-0 z-30 player-in mini-offset">
      {/* mobile strip — sits above the tab bar; the bar owns the safe area */}
      <div className="md:hidden ui-dark"
        onTouchStart={e => { swipeX.current = e.touches[0].clientX; }}
        onTouchEnd={e => {
          if (swipeX.current == null) return;
          const dx = e.changedTouches[0].clientX - swipeX.current;
          swipeX.current = null;
          if (dx < -60) next();
          else if (dx > 60) prev();
        }}>
          {/* scrubbable: seek from the mini bar itself, one-handed, no need to
              open the full player; touch stopPropagation keeps the bar's
              left/right skip-swipe from fighting the scrub */}
          <div ref={miniBarRef}
            onPointerDown={e => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ } miniScrub(e.clientX); }}
            onPointerMove={e => { if (e.buttons & 1) miniScrub(e.clientX); }}
            onTouchStart={e => e.stopPropagation()}
            onTouchEnd={e => e.stopPropagation()}
            className="relative h-4 flex items-center touch-none" role="slider" aria-label="Seek"
            aria-valuenow={Math.round(currentTime)} aria-valuemax={Math.round(duration || 0)}>
            <div className="w-full h-1 bg-[var(--surface-3)]"><div className={`h-full bg-accent ${buffering ? 'animate-pulse' : ''}`} style={{ width: `${pct}%` }} /></div>
          </div>
          <div className="glass px-2 h-16 flex items-center gap-1 sp-playerbar">
            <button onClick={() => setShowFullPlayer(true)} className="flex items-center gap-3 flex-1 min-w-0 text-left" aria-label="Open full player">
              <Img src={track.image} alt={track.title} className="w-12 h-12 rounded-[7px] object-cover shadow-[var(--shadow-1)]" />
              <span className="min-w-0">
                <p className="truncate text-[14px] font-semibold flex items-center gap-2">{isPlaying && <EqIcon />}{track.title}</p>
                {/* the mini bar names the state too: loading / failed / paused /
                    ended read at a glance without opening the sheet */}
                <p className={`truncate t-caption ${playError ? 'text-red-400' : buffering ? 'animate-pulse' : ''}`}>
                  {playError ? 'Playback failed' : buffering ? 'Loading…' : ended ? 'Ended · tap replay' : isPlaying ? track.artist?.name : `Paused · ${track.artist?.name || ''}`}
                </p>
              </span>
            </button>
          <button onClick={prev} className="w-11 h-11 grid place-items-center text-dim hover:text-white btn-press" aria-label="Previous"><PrevIcon size={22} /></button>
          <button onClick={onPlayBtn} className={`w-11 h-11 rounded-full btn-accent grid place-items-center shadow-[0_0_24px_-6px_var(--accent)] ${playError ? 'ring-2 ring-red-500' : ''}`} aria-label={buffering ? 'Loading audio' : playError ? 'Playback failed, retry' : ended ? 'Replay' : isPlaying ? 'Pause' : 'Play'}>{buffering ? <SpinIcon size={19} /> : ended ? <RefreshIcon size={19} /> : isPlaying ? <PauseIcon size={19} /> : <PlayIcon size={19} />}</button>
          <button onClick={next} className="w-11 h-11 grid place-items-center text-dim hover:text-white btn-press" aria-label="Next"><NextIcon size={22} /></button>
        </div>
      </div>
      {/* desktop 3-zone bar */}
        <div className="hidden md:grid grid-cols-[1fr_1.3fr_1fr] items-center h-[88px] px-5 gap-4 sp-playerbar">
          <div className="flex items-center gap-3.5 min-w-0">
            <button onClick={() => setShowFullPlayer(true)} className="shrink-0 rounded-[8px] overflow-hidden shadow-[var(--shadow-2)] transition-transform duration-300 hover:scale-[1.04]" aria-hidden="true" tabIndex={-1}>
              <Img src={track.image} alt={track.title} className="w-14 h-14 object-cover" />
            </button>
            <div key={track.id} className="anim-in min-w-0 max-w-[220px] text-fade-x">
              <p className="truncate text-[14px] font-semibold" style={{ color: 'var(--text)' }}>{track.title}</p>
              <p className="truncate t-caption">{track.artist?.name}</p>
            </div>
          <button onClick={() => toggleLike(track)} aria-label="Like" className={`p-2 btn-press ${isLiked ? 'accent' : 'text-dim hover:text-white'}`}>
            <HeartIcon size={17} filled={isLiked} />
          </button>
        </div>
        <div className="flex flex-col items-center gap-1 max-w-2xl w-full mx-auto">
          <div className="flex items-center gap-5">
            <button onClick={toggleShuffle} aria-label="Shuffle" className={`relative p-1 btn-press ${shuffle ? 'accent' : 'text-dim hover:text-white'}`}>
              <ShuffleIcon size={17} />
              {shuffle && <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-accent" />}
            </button>
            <button onClick={prev} aria-label="Previous" className="p-1 text-dim hover:text-white btn-press"><PrevIcon size={20} /></button>
            <button onClick={togglePlay} aria-label={buffering && isPlaying ? 'Loading audio' : isPlaying ? 'Pause' : 'Play'} className="w-9 h-9 rounded-full btn-accent grid place-items-center shadow-[0_0_24px_-6px_var(--accent)]">
              {buffering && isPlaying ? <SpinIcon size={17} /> : isPlaying ? <PauseIcon size={17} /> : <PlayIcon size={17} />}
            </button>
            <button onClick={next} aria-label="Next" className="p-1 text-dim hover:text-white btn-press"><NextIcon size={20} /></button>
            <button onClick={cycleRepeat} aria-label="Repeat" className={`relative p-1 btn-press ${repeat !== 'off' ? 'accent' : 'text-dim hover:text-white'}`}>
              {repeat === 'one' ? <RepeatOneIcon size={17} /> : <RepeatIcon size={17} />}
              {repeat !== 'off' && <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-accent" />}
            </button>
          </div>
          <ProgressBar currentTime={currentTime} duration={duration} />
        </div>
        <div className="flex items-center justify-end gap-1">
          <button onClick={() => setShowFullPlayer(true)} aria-label="Lyrics" title="Lyrics" className="p-2 text-dim hover:text-white transition-colors"><MicIcon size={17} /></button>
          <button onClick={() => setShowQueue(true)} aria-label="Queue" title="Queue" className="p-2 text-dim hover:text-white transition-colors"><QueueIcon size={19} /></button>
          <button onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'} className="p-2 text-dim hover:text-white transition-colors">
            {muted || volume === 0 ? <MuteIcon size={19} /> : <VolumeIcon size={19} />}
          </button>
          <span className="slider-wrap w-24 hidden lg:block">
            <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume"
              onChange={(e) => setVolume(Number(e.target.value))} className="slider w-full"
              style={{ background: `linear-gradient(90deg, var(--text) ${(muted ? 0 : volume) * 100}%, rgba(128,128,128,.4) ${(muted ? 0 : volume) * 100}%)` }} />
          </span>
          <button onClick={() => setShowFullPlayer(true)} aria-label="Expand player" title="Full screen" className="p-2 text-dim hover:text-white transition-colors"><ExpandIcon size={16} /></button>
        </div>
      </div>
    </div>
  );
}

function parseLRC(text) {
  const out = [];
  for (const ln of String(text || '').split('\n')) {
    const m = ln.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
    if (!m) continue;
    const t = (+m[1]) * 60 + (+m[2]) + (+(m[3] || '0')) / ((m[3] || '').length === 3 ? 1000 : 100);
    if (m[4].trim()) out.push({ t, text: m[4].trim() });
  }
  return out.sort((a, b) => a.t - b.t);
}

function Lyrics({ track }) {
  const [lyrics, setLyrics] = useState(null);
  const [loading, setLoading] = useState(false);
  const currentTime = useStore(s => s.currentTime);
  const wrapRef = useRef(null);
  const lineRefs = useRef([]);
  const followLock = useRef(0);   // timestamp: manual scrolls pause auto-follow briefly
  const progScroll = useRef(false); // programmatic scroll in flight (ignore its scroll events)
  useEffect(() => {
    if (!track) return;
    setLoading(true); setLyrics(null);
    api.lyrics({ artist: track.artist?.name, title: track.title, duration: track.duration, album: track.album?.name })
      .then(r => setLyrics(r.lyrics))
      .catch(() => setLyrics(null))
      .finally(() => setLoading(false));
  }, [track?.id]);
  useEffect(() => { // fresh track: rewind list to top
    lineRefs.current = [];
    try { wrapRef.current?.scrollTo({ top: 0 }); } catch {}
  }, [track?.id]);
  if (loading) return (
    <div className="flex flex-col gap-3 py-4" aria-label="Loading lyrics">
      {[92, 78, 86, 64, 88, 72].map((w, i) => (
        <div key={i} className="skeleton h-6 rounded-lg" style={{ width: `${w}%`, animationDelay: `${i * 0.12}s` }} />
      ))}
    </div>
  );
  if (!lyrics) return (
    <div className="fade-in flex flex-col items-center gap-3 py-10 text-center">
      <span className="w-14 h-14 rounded-full bg-white/5 grid place-items-center text-dim"><MicIcon size={24} /></span>
      <p className="text-sm text-dim">Lyrics not available for this track.</p>
    </div>
  );
  const lines = parseLRC(lyrics);
  if (!lines.length) return <p className="anim-in whitespace-pre-line text-[15px] leading-8 font-medium">{lyrics}</p>;
  let ai = -1;
  lines.forEach((l, i) => { if (currentTime >= l.t) ai = i; });
  return (
    <div ref={wrapRef} onScroll={() => {
        if (progScroll.current) return;
        followLock.current = Date.now() + 6000; // let the user browse; resume follow after 6s idle
      }}
      className="lyrics-mask relative flex flex-col gap-2 max-h-[46vh] md:max-h-[54vh] overflow-y-auto sheet-scroll px-1 py-[14vh]" aria-label="Synchronized lyrics">
      {ai === -1 && (
        <div className="lyric-prelude flex items-center gap-2 text-dim px-1" aria-hidden>
          <NoteIcon size={18} /><span className="text-sm font-bold tracking-wide">Music playing…</span>
        </div>
      )}
      {lines.map((l, i) => {
        if (i === ai) {
          const el = lineRefs.current[i], wrap = wrapRef.current;
          if (el && wrap && Date.now() >= followLock.current) {
            progScroll.current = true;
            try {
              const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
              wrap.scrollTo({ top: el.offsetTop - wrap.clientHeight / 2 + el.clientHeight / 2, behavior: reduce ? 'auto' : 'smooth' });
            } catch {}
            setTimeout(() => { progScroll.current = false; }, 600);
          }
        }
        const cls = i === ai ? 'lyric-active' : i < ai ? 'lyric-past text-dim' : (i - ai === 1 ? 'lyric-near text-dim' : 'lyric-far text-dim');
        return <p key={i} ref={(r) => { lineRefs.current[i] = r; }}
          className={`lyric-line text-[19px] md:text-[22px] font-extrabold tracking-tight leading-[1.5] ${cls}`}>{l.text}</p>;
      })}
    </div>
  );
}

function AddToPlaylistMenu({ track, onDone }) {
  const playlists = useStore(s => s.playlists);
  const createPlaylist = useStore(s => s.createPlaylist);
  const addToPlaylist = useStore(s => s.addToPlaylist);
  const toast = useStore(s => s.toast);
  const [name, setName] = useState('');
  return (
    <div className="panel p-3 w-64 max-h-72 overflow-y-auto">
      <p className="text-xs font-bold text-dim mb-2">ADD TO PLAYLIST</p>
      {playlists.map(p => (
        <button key={p.id} onClick={() => { addToPlaylist(p.id, track); toast(`Added to ${p.name}`); onDone?.(); }}
          className="w-full text-left px-2 py-1.5 rounded-lg text-sm bg-hoverable truncate"><NoteIcon size={14} className="inline mr-1.5 -mt-0.5" />{p.name}</button>
      ))}
      <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; const id = createPlaylist(name.trim()); addToPlaylist(id, track); toast('Playlist created & song added'); onDone?.(); }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="New playlist…" className="flex-1 min-w-0 bg-soft border border-soft rounded-lg px-2 py-1 text-sm outline-none" />
        <button className="btn-accent px-2 py-1 text-sm" aria-label="Create"><PlusIcon size={14} /></button>
      </form>
    </div>
  );
}

/**
 * The rectangle the embedded YouTube player is drawn into.
 *
 * The player is a single fixed-position iframe owned by ytPlayer.js and is
 * never re-parented — moving an iframe in the DOM reloads it, which would
 * restart the video on every mode switch. This div only tells that module
 * where to paint, so it can come and go freely.
 */
function YtVideoSurface({ className }) {
  const ref = useRef(null);
  useEffect(() => {
    setYouTubeHost(ref.current);
    return () => setYouTubeHost(null);
  }, []);
  return <div ref={ref} className={className} />;
}

/** Audio-only vs. video for YouTube tracks. */
function YtModeToggle() {
  const ytMode = useStore(s => s.ytMode);
  const setYtMode = useStore(s => s.setYtMode);
  const opt = (v, label) => (
    <button onClick={() => setYtMode(v)} aria-pressed={ytMode === v}
      className={`px-3 py-1 rounded-full text-[11px] font-extrabold tracking-wide transition-colors ${ytMode === v ? 'bg-accent text-black' : 'bg-white/10 text-dim'}`}>
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-1 p-1 rounded-full bg-black/40 border border-soft" role="group" aria-label="YouTube playback mode">
      {opt('audio', 'MP3')}
      {opt('video', 'VIDEO')}
    </div>
  );
}

export function FullPlayer() {
  const show = useStore(s => s.showFullPlayer);
  const setShow = useStore(s => s.setShowFullPlayer);
  const queue = useStore(s => s.queue);
  const index = useStore(s => s.index);
  const isPlaying = useStore(s => s.isPlaying);
  const togglePlay = useStore(s => s.togglePlay);
  const next = useStore(s => s.next);
  const prev = useStore(s => s.prev);
  const shuffle = useStore(s => s.shuffle);
  const repeat = useStore(s => s.repeat);
  const toggleShuffle = useStore(s => s.toggleShuffle);
  const cycleRepeat = useStore(s => s.cycleRepeat);
  const volume = useStore(s => s.volume);
  const muted = useStore(s => s.muted);
  const setVolume = useStore(s => s.setVolume);
  const setMuted = useStore(s => s.setMuted);
  const currentTime = useStore(s => s.currentTime);
  const duration = useStore(s => s.duration);
  const liked = useStore(s => s.liked);
  const toggleLike = useStore(s => s.toggleLike);
  const downloads = useStore(s => s.downloads);
  const toggleDownload = useStore(s => s.toggleDownload);
  const sleepTimerMin = useStore(s => s.sleepTimerMin);
  const setSleepTimer = useStore(s => s.setSleepTimer);
  const buffering = useStore(s => s.buffering);
  const playError = useStore(s => s.playError);
  const playbackRate = useStore(s => s.playbackRate);
  const setPlaybackRate = useStore(s => s.setPlaybackRate);
  const gain = useStore(s => s.gain);
  const setGain = useStore(s => s.setGain);
  const abLoop = useStore(s => s.abLoop);
  const cycleLoopPoint = useStore(s => s.cycleLoopPoint);
  const party = useStore(s => s.party);
  const setShowParty = useStore(s => s.setShowParty);
  const cycleSpeed = () => { const steps = [1, 1.25, 1.5, 2, 0.5]; setPlaybackRate(steps[(steps.indexOf(playbackRate) + 1) % steps.length]); };
  const setShowQueue = useStore(s => s.setShowQueue);
  const studioOn = useStore(s => s.studioOn);
  const ytMode = useStore(s => s.ytMode);
  const setStudioOn = useStore(s => s.setStudioOn);
  const toast = useStore(s => s.toast);
  const [tab, setTab] = useState('lyrics');
  const [showPlMenu, setShowPlMenu] = useState(false);
  const [showSleep, setShowSleep] = useState(false);
  const touchY = useRef(null);
  const sheetRef = useRef(null);
  useEffect(() => {
    if (!show) return;
    const h = (e) => {
      if (e.key !== 'Escape') return;
      if (showPlMenu) setShowPlMenu(false);
      else if (showSleep) setShowSleep(false);
      else setShow(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [show, showPlMenu, showSleep]);

  const track = index >= 0 ? queue[index] : null;
  if (!show || !track) return null;
  const isLiked = !!liked[track.id];
  const playLabel = 'FULL TRACK';
  const ended = !isPlaying && !buffering && duration > 0 && currentTime >= duration - 0.5;
  const status = playError ? 'FAILED' : buffering ? 'LOADING' : ended ? 'ENDED' : isPlaying ? 'NOW PLAYING' : 'PAUSED';
  const onPlayBtn = () => { if (ended) seekTo(0); togglePlay(); };

  const share = async () => {
    const url = `${location.origin}/search?q=${encodeURIComponent(track.title + ' ' + track.artist?.name)}`;
    const data = { title: track.title, text: `🎵 ${track.title} — ${track.artist?.name} (via SoundWave)`, url };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(`${data.text}\n${url}`); toast('Share link copied'); }
    } catch { /* dismissed */ }
  };

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto sheet-scroll ui-dark" role="dialog" aria-label="Now playing"
      onTouchStart={e => { touchY.current = e.touches[0].clientY; }}
      onTouchMove={e => {
        if (touchY.current == null || e.currentTarget.scrollTop > 0) return;
        const dy = e.touches[0].clientY - touchY.current;
        if (sheetRef.current) sheetRef.current.style.transform = dy > 0 ? `translateY(${Math.min(dy, 160)}px)` : '';
      }}
      onTouchEnd={e => {
        if (touchY.current == null) return;
        const dy = e.changedTouches[0].clientY - touchY.current;
        touchY.current = null;
        if (sheetRef.current) sheetRef.current.style.transform = '';
        if (dy > 100 && e.currentTarget.scrollTop <= 0) setShow(false);
      }}>
      <div key={track.image} className="fade-in-slow absolute inset-0 bg-cover bg-center blur-3xl scale-125 opacity-50" style={{ backgroundImage: `url(${track.image})` }} />
      <div className="fade-in absolute inset-0 bg-black/80 backdrop-blur-2xl" />
      <div ref={sheetRef} className="sheet-in relative max-w-5xl mx-auto px-4 py-6 min-h-full flex flex-col">
        <div className="flex items-center justify-between">
          <button onClick={() => setShow(false)} className="w-11 h-11 grid place-items-center btn-press" aria-label="Close player"><ChevronDownIcon size={22} /></button>
          {/* the state word is the first thing on the sheet: playing / paused /
              loading / failed / ended are always visible at a glance */}
          <p className={`text-xs font-bold tracking-widest ${playError ? 'text-red-400' : buffering ? 'text-dim animate-pulse' : isPlaying ? 'accent' : 'text-dim'}`} aria-live="polite">{status} · {playLabel}{studioOn ? ' · STUDIO' : ''}</p>
          <button onClick={() => setShowQueue(true)} className="w-11 h-11 grid place-items-center btn-press" aria-label="Open queue"><QueueIcon size={21} /></button>
        </div>
        <div className="grid md:grid-cols-2 gap-8 mt-6 items-start">
          <div className="flex flex-col items-center">
            {isYouTubeTrack(track) && ytMode === 'video' ? (
              <YtVideoSurface className="w-full max-w-2xl aspect-video rounded-2xl overflow-hidden bg-black shadow-2xl border border-white/10" />
            ) : (
            <div className={`relative ${isPlaying ? 'animate-spin-slower' : 'paused-spin animate-spin-slower'}`}>
              {/* paused/ended: the disc visibly cools down (desaturate + dim) so
                  state reads from across the room, not just the header word */}
              <Img src={track.image} alt={track.title} className={`w-56 md:w-80 max-w-[62vw] aspect-square h-auto rounded-full object-cover shadow-2xl border-8 border-black/60 transition-[box-shadow,filter,opacity] duration-700 ${isPlaying ? 'shadow-[0_0_90px_-18px_var(--accent)]' : 'saturate-[.7] opacity-85'}`} />
              <div className="absolute inset-0 grid place-items-center"><div className="w-16 h-16 rounded-full bg-black/80 border-4 border-white/20" /></div>
              {buffering && (
                <div className="absolute inset-0 grid place-items-center">
                  <span className="w-14 h-14 rounded-full bg-black/70 grid place-items-center text-white"><SpinIcon size={26} /></span>
                </div>
              )}
            </div>
            )}
            <div className="w-full mt-4">
              {studioOn ? <Visualizer /> : (
                <button onClick={() => { setStudioOn(true); setTab('studio'); toast('Studio sound on'); }}
                  className="w-full py-2 rounded-xl text-xs font-bold bg-white/5 border border-dashed border-soft text-dim">
                  Turn on Studio sound for a live visualizer + EQ
                </button>
              )}
            </div>
            <div key={track.id} className="anim-in flex flex-col items-center">
              <h1 className="mt-4 text-2xl font-extrabold text-center text-balance">{track.title}</h1>
              <p className="text-dim font-semibold text-center">{track.artist?.name}{track.album?.name ? ` · ${track.album.name}` : ''}</p>
              {isYouTubeTrack(track) && <div className="mt-3"><YtModeToggle /></div>}
            </div>
            <div className="w-full mt-5 slider-wrap">
              <input data-seeking="1" type="range" min={0} max={duration || 0} step={0.5} value={currentTime}
                onChange={(e) => seekTo(Number(e.target.value))} className="slider w-full" aria-label="Seek"
                style={{ background: `linear-gradient(90deg, var(--accent) ${duration ? (currentTime / duration) * 100 : 0}%, rgba(128,128,128,.4) ${duration ? (currentTime / duration) * 100 : 0}%)` }} />
              <div className="flex justify-between text-xs text-dim mt-1"><span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span></div>
            </div>
            <div className="flex items-center gap-2 mt-3">
              <button onClick={toggleShuffle} className={`w-11 h-11 grid place-items-center btn-press ${shuffle ? 'accent' : 'text-dim'}`} aria-label="Shuffle" title="Shuffle" aria-pressed={shuffle}><ShuffleIcon size={20} /></button>
              <button onClick={prev} className="w-11 h-11 grid place-items-center text-white/80 hover:text-white btn-press" aria-label="Previous"><PrevIcon size={28} /></button>
              <button onClick={onPlayBtn} className="w-[72px] h-[72px] rounded-full btn-accent grid place-items-center shadow-[0_0_44px_-8px_var(--accent)]" aria-label={buffering ? 'Loading audio' : ended ? 'Replay' : isPlaying ? 'Pause' : 'Play'}>{buffering ? <SpinIcon size={28} /> : ended ? <RefreshIcon size={28} /> : isPlaying ? <PauseIcon size={28} /> : <PlayIcon size={28} />}</button>
              <button onClick={next} className="w-11 h-11 grid place-items-center text-white/80 hover:text-white btn-press" aria-label="Next"><NextIcon size={28} /></button>
              <button onClick={cycleRepeat} className={`w-11 h-11 grid place-items-center btn-press ${repeat !== 'off' ? 'accent' : 'text-dim'}`} aria-label="Repeat" title={`Repeat: ${repeat}`}>{repeat === 'one' ? <RepeatOneIcon size={20} /> : <RepeatIcon size={20} />}</button>
            </div>
            {playError && (
              <div className="mt-4 w-full max-w-xs rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-center" role="alert">
                <p className="text-sm font-bold text-red-400">{playError}</p>
                <button onClick={next} className="chip chip-active mt-2">Skip to next</button>
              </div>
            )}
            <div className="flex items-center gap-2 mt-4 w-full max-w-xs slider-wrap">
              <button onClick={() => setMuted(!muted)} aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'} className="w-11 h-11 grid place-items-center btn-press shrink-0">{muted || volume === 0 ? <MuteIcon size={20} /> : <VolumeIcon size={20} />}</button>
              <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => setVolume(Number(e.target.value))} className="slider flex-1" aria-label="Volume"
                style={{ background: `linear-gradient(90deg, var(--text) ${(muted ? 0 : volume) * 100}%, rgba(128,128,128,.4) ${(muted ? 0 : volume) * 100}%)` }} />
              <button onClick={cycleSpeed} className="text-xs font-extrabold px-2 rounded-md bg-white/10 min-w-[46px] min-h-[40px]" aria-label="Playback speed" title="Playback speed">{playbackRate}×</button>
            </div>
            <div className="flex items-center gap-2 mt-2 w-full max-w-xs slider-wrap" title="Volume boost up to 200%">
              <span className="text-[11px] font-extrabold text-dim w-12 shrink-0">BOOST</span>
              <input type="range" min={1} max={2} step={0.05} value={gain} onChange={(e) => setGain(Number(e.target.value))} className="slider flex-1" aria-label="Volume boost"
                style={{ background: `linear-gradient(90deg, var(--text) ${(gain - 1) * 100}%, rgba(128,128,128,.4) ${(gain - 1) * 100}%)` }} />
              <span className="text-[11px] font-extrabold text-dim w-10 text-right tabular-nums shrink-0">{Math.round(gain * 100)}%</span>
            </div>
            <div className="flex items-center gap-2 mt-5 flex-wrap justify-center">
              <button onClick={() => toggleLike(track)} className={`px-4 min-h-[44px] rounded-full text-sm font-bold inline-flex items-center gap-1.5 transition-all active:scale-95 ${isLiked ? 'bg-accent text-black' : 'bg-white/10'}`}><HeartIcon size={15} filled={isLiked} />{isLiked ? 'Liked' : 'Like'}</button>
              <div className="relative">
                <button onClick={() => setShowPlMenu(v => !v)} aria-expanded={showPlMenu} className="px-4 min-h-[44px] rounded-full text-[13px] font-semibold bg-[var(--surface-2)] inline-flex items-center gap-1.5 transition-all active:scale-95"><PlusIcon size={15} />Playlist</button>
                {showPlMenu && <div className="absolute bottom-12 left-1/2 -translate-x-1/2 sm:left-0 sm:translate-x-0 z-10"><AddToPlaylistMenu track={track} onDone={() => setShowPlMenu(false)} /></div>}
              </div>
              <button onClick={() => cycleLoopPoint(currentTime)} aria-label="Loop section (A-B)" title="Loop a section: tap to set A, again for B, again to clear"
                className={`px-4 min-h-[44px] rounded-full text-sm font-bold inline-flex items-center gap-1.5 transition-all active:scale-95 ${abLoop.b != null ? 'bg-accent text-black' : abLoop.a != null ? 'bg-accent/30 text-white' : 'bg-white/10'}`}>
                <RepeatIcon size={15} />{abLoop.b != null ? `${formatTime(abLoop.a)}–${formatTime(abLoop.b)}` : abLoop.a != null ? `A ${formatTime(abLoop.a)}…` : 'A–B'}
              </button>
              <button onClick={() => setShowParty(true)} aria-label="Listen Together" title="Listen Together: host or join a synced party"
                className="px-4 min-h-[44px] rounded-full text-[13px] font-semibold bg-[var(--surface-2)] inline-flex items-center gap-1.5 transition-all active:scale-95">
                <span className={`w-2 h-2 rounded-full ${party ? 'bg-green-500 animate-pulse' : 'bg-white/30'}`} aria-hidden />Together{party ? ` ${party.code}` : ''}
              </button>
              <button onClick={share} className="px-4 min-h-[44px] rounded-full text-[13px] font-semibold bg-[var(--surface-2)] inline-flex items-center gap-1.5 transition-all active:scale-95"><ShareIcon size={15} />Share</button>
              <button onClick={() => { toggleDownload(track); toast(downloads[track.id] ? 'Removed from offline' : 'Saved for offline'); }} className="px-4 min-h-[44px] rounded-full text-[13px] font-semibold bg-[var(--surface-2)] inline-flex items-center gap-1.5 transition-all active:scale-95">
                {downloads[track.id] ? <CheckIcon size={15} /> : <DownloadIcon size={15} />}Offline
              </button>
              <div className="relative">
                <button onClick={() => setShowSleep(v => !v)} className={`px-4 min-h-[44px] rounded-full text-sm font-bold inline-flex items-center gap-1.5 transition-all active:scale-95 ${sleepTimerMin ? 'bg-accent text-black' : 'bg-white/10'}`}>
                  <MoonIcon size={15} />{sleepTimerMin ? `${sleepTimerMin}m` : 'Sleep'}
                </button>
                {showSleep && (
                  <div className="panel absolute bottom-12 left-1/2 -translate-x-1/2 sm:left-0 sm:translate-x-0 p-2 w-40">
                    {[0, 5, 10, 15, 30, 45, 60].map(m => (
                      <button key={m} onClick={() => { setSleepTimer(m); setShowSleep(false); toast(m ? `Sleep timer: ${m} min` : 'Sleep timer off'); }}
                        className="w-full text-left px-2 py-1.5 rounded-lg text-sm bg-hoverable">{m === 0 ? 'Off' : `${m} minutes`}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="panel p-4 min-h-[300px]">
            <div className="flex gap-2 mb-3 overflow-x-auto no-scrollbar">
              {[['lyrics', 'Lyrics'], ['studio', 'Studio'], ['info', 'Details']].map(([t, label]) => (
                <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t} className={`px-4 py-2.5 min-h-[44px] rounded-full text-sm font-bold shrink-0 border transition-all active:scale-95 ${tab === t ? 'bg-accent text-black border-transparent' : 'bg-white/10 border-soft'}`}>{label}</button>
              ))}
            </div>
            <div key={tab} className="fade-in">
            {tab === 'lyrics' ? <Lyrics track={track} /> : tab === 'studio' ? <Equalizer /> : (
              <div className="text-sm flex flex-col gap-2">
                <p><b>Title:</b> {track.title}</p>
                <p><b>Artist:</b> {track.artist?.name}</p>
                <p><b>Album:</b> {track.album?.name} {track.album?.year && `(${track.album.year})`}</p>
                <p><b>Duration:</b> {formatTime(track.duration)}</p>
                <p><b>Source:</b> {({ djp: 'DJPunjab', dj: 'DJJohal', mrj: 'Mr-Jatt', saavn: 'JioSaavn' })[track.source] || track.source}{track.mirrors?.length > 1 ? ` (+${track.mirrors.length - 1} mirrors)` : ''} · full MP3</p>
                {track.codec && <p><b>Codec:</b> {track.codec.toUpperCase()}{track.quality ? ` · ${track.quality}kbps` : ''}</p>}
                {track.language && <p><b>Language:</b> {track.language}</p>}
                {track.playCount > 0 && <p><b>Plays:</b> {Number(track.playCount).toLocaleString()}</p>}
              </div>
            )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function QueueDrawer() {
  const show = useStore(s => s.showQueue);
  const setShow = useStore(s => s.setShowQueue);
  const queue = useStore(s => s.queue);
  const index = useStore(s => s.index);
  const removeFromQueue = useStore(s => s.removeFromQueue);
  const moveInQueue = useStore(s => s.moveInQueue);
  const clearQueue = useStore(s => s.clearQueue);
  const playTracks = useStore(s => s.playTracks);
  useEffect(() => {
    if (!show) return;
    const h = (e) => { if (e.key === 'Escape') setShow(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [show]);
  if (!show) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="Queue">
      <div className="fade-in absolute inset-0 bg-black/60" onClick={() => setShow(false)} />
      <div className="absolute right-0 top-0 bottom-0 w-full max-w-md bg-soft border-l border-soft p-4 overflow-y-auto drawer-in sheet-scroll">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-extrabold">Queue ({queue.length})</h2>
          <div className="flex gap-2">
            <button onClick={() => { clearQueue(); setShow(false); }} className="text-xs font-bold px-4 py-2.5 min-h-[40px] rounded-full bg-white/10">Clear</button>
            <button onClick={() => setShow(false)} className="w-11 h-11 grid place-items-center" aria-label="Close queue"><CloseIcon size={18} /></button>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {queue.map((t, i) => (
            <div key={`${t.id}-${i}`} className={`flex items-center gap-2 p-1.5 rounded-lg transition-colors ${i === index ? 'bg-accent/10' : 'bg-hoverable'}`}>
              <button onClick={() => { playTracks(queue, i); }} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                <Img src={t.image} alt="" className="w-10 h-10 rounded object-cover" />
                <span className="min-w-0"><p className={`truncate text-sm font-semibold ${i === index ? 'accent' : ''}`}>{t.title}</p><p className="truncate text-xs text-dim">{t.artist?.name}</p></span>
              </button>
              {i === index && <EqIcon />}
              <span className="flex flex-col shrink-0">
                <button onClick={() => moveInQueue(i, i - 1)} disabled={i === 0} className="text-dim w-10 h-9 grid place-items-center text-[11px] disabled:opacity-20 active:scale-90" aria-label="Move up">▲</button>
                <button onClick={() => moveInQueue(i, i + 1)} disabled={i === queue.length - 1} className="text-dim w-10 h-9 grid place-items-center text-[11px] disabled:opacity-20 active:scale-90" aria-label="Move down">▼</button>
              </span>
              <button onClick={() => removeFromQueue(i)} className="text-dim w-11 h-11 grid place-items-center active:scale-90" aria-label="Remove from queue"><CloseIcon size={14} /></button>
            </div>
          ))}
          {queue.length === 0 && <p className="text-sm text-dim">Queue is empty. Play something!</p>}
        </div>
        <SimilarSongs />
      </div>
    </div>
  );
}
