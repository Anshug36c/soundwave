import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { api, formatTime } from '../services/musicApi';
import { seekTo } from '../hooks/useAudioEngine';
import { Img, EqIcon } from './Cards';
import Equalizer from './Equalizer';
import Visualizer from './Visualizer';

export function MiniPlayer() {
  const queue = useStore(s => s.queue);
  const index = useStore(s => s.index);
  const isPlaying = useStore(s => s.isPlaying);
  const togglePlay = useStore(s => s.togglePlay);
  const next = useStore(s => s.next);
  const prev = useStore(s => s.prev);
  const currentTime = useStore(s => s.currentTime);
  const duration = useStore(s => s.duration);
  const setShowFullPlayer = useStore(s => s.setShowFullPlayer);
  const track = index >= 0 ? queue[index] : null;

  if (!track) return null;
  const pct = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30">
      <div className="h-1 bg-white/10"><div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} /></div>
      <div className="glass bg-black/60 border-t border-soft px-3 py-2 flex items-center gap-3">
        <button onClick={() => setShowFullPlayer(true)} className="flex items-center gap-3 flex-1 min-w-0 text-left" aria-label="Open full player">
          <Img src={track.image || track.thumbnails?.small} alt={track.title} className="w-12 h-12 rounded-md object-cover" />
          <span className="min-w-0">
            <p className="truncate text-sm font-bold flex items-center gap-2">{isPlaying && <EqIcon />}{track.title}</p>
            <p className="truncate text-xs text-dim">{track.artist?.name}</p>
          </span>
        </button>
        <button onClick={prev} className="text-xl px-2" aria-label="Previous">⏮</button>
        <button onClick={togglePlay} className="w-11 h-11 rounded-full btn-accent grid place-items-center text-lg" aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? '⏸' : '▶'}</button>
        <button onClick={next} className="text-xl px-2" aria-label="Next">⏭</button>
      </div>
    </div>
  );
}

function Lyrics({ track }) {
  const [lyrics, setLyrics] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!track) return;
    setLoading(true); setLyrics(null);
    api.lyrics({ saavnId: track.source === 'saavn' ? track.sourceId : undefined, artist: track.artist?.name, title: track.title })
      .then(r => setLyrics(r.lyrics))
      .catch(() => setLyrics(null))
      .finally(() => setLoading(false));
  }, [track?.id]);
  if (loading) return <div className="skeleton h-40 rounded-xl" />;
  if (!lyrics) return <p className="text-sm text-dim">Lyrics not available for this track.</p>;
  return <p className="whitespace-pre-line text-sm leading-7">{lyrics}</p>;
}

function AddToPlaylistMenu({ track, onDone }) {
  const playlists = useStore(s => s.playlists);
  const createPlaylist = useStore(s => s.createPlaylist);
  const addToPlaylist = useStore(s => s.addToPlaylist);
  const toast = useStore(s => s.toast);
  const [name, setName] = useState('');
  return (
    <div className="card p-3 w-64 max-h-72 overflow-y-auto">
      <p className="text-xs font-bold text-dim mb-2">ADD TO PLAYLIST</p>
      {playlists.map(p => (
        <button key={p.id} onClick={() => { addToPlaylist(p.id, track); toast(`Added to ${p.name}`); onDone?.(); }}
          className="w-full text-left px-2 py-1.5 rounded-lg text-sm bg-hoverable truncate">🎵 {p.name}</button>
      ))}
      <form className="mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; const id = createPlaylist(name.trim()); addToPlaylist(id, track); toast('Playlist created & song added'); onDone?.(); }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="New playlist…" className="flex-1 min-w-0 bg-soft border border-soft rounded-lg px-2 py-1 text-sm outline-none" />
        <button className="btn-accent px-2 text-sm">＋</button>
      </form>
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
  const setShowQueue = useStore(s => s.setShowQueue);
  const studioOn = useStore(s => s.studioOn);
  const setStudioOn = useStore(s => s.setStudioOn);
  const toast = useStore(s => s.toast);
  const [tab, setTab] = useState('lyrics');
  const [showPlMenu, setShowPlMenu] = useState(false);
  const [showSleep, setShowSleep] = useState(false);

  const track = index >= 0 ? queue[index] : null;
  if (!show || !track) return null;
  const isLiked = !!liked[track.id];
  const playLabel = track.isPreview ? '30s PREVIEW' : 'FULL TRACK';

  const share = async () => {
    const url = `${location.origin}/search?q=${encodeURIComponent(track.title + ' ' + track.artist?.name)}`;
    const data = { title: track.title, text: `🎵 ${track.title} — ${track.artist?.name} (via SoundWave)`, url };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(`${data.text}\n${url}`); toast('Share link copied'); }
    } catch { /* dismissed */ }
  };

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto" role="dialog" aria-label="Now playing">
      <div className="absolute inset-0 bg-cover bg-center blur-3xl scale-110 opacity-40" style={{ backgroundImage: `url(${track.image})` }} />
      <div className="absolute inset-0 bg-black/70" />
      <div className="relative max-w-5xl mx-auto px-4 py-6 min-h-full flex flex-col">
        <div className="flex items-center justify-between">
          <button onClick={() => setShow(false)} className="text-2xl px-2" aria-label="Close player">⌄</button>
          <p className="text-xs font-bold tracking-widest text-dim">NOW PLAYING · {playLabel}{studioOn ? ' · 🎚️ STUDIO' : ''}</p>
          <button onClick={() => setShowQueue(true)} className="text-xl px-2" aria-label="Open queue">☰</button>
        </div>
        <div className="grid md:grid-cols-2 gap-8 mt-6 items-start">
          <div className="flex flex-col items-center">
            <div className={`relative ${isPlaying ? 'animate-spin-slow' : 'paused-spin animate-spin-slow'}`}>
              <Img src={track.image || track.thumbnails?.large} alt={track.title} className="w-64 h-64 md:w-80 md:h-80 rounded-full object-cover shadow-2xl border-8 border-black/60" />
              <div className="absolute inset-0 grid place-items-center"><div className="w-16 h-16 rounded-full bg-black/80 border-4 border-white/20" /></div>
            </div>
            <div className="w-full mt-4">
              {studioOn ? <Visualizer /> : (
                <button onClick={() => { setStudioOn(true); setTab('studio'); toast('Studio sound on 🎚️'); }}
                  className="w-full py-2 rounded-xl text-xs font-bold bg-white/5 border border-dashed border-soft text-dim">
                  〰️ Turn on Studio sound for a live visualizer + EQ
                </button>
              )}
            </div>
            <h1 className="mt-4 text-2xl font-extrabold text-center">{track.title}</h1>
            <p className="text-dim font-semibold">{track.artist?.name} · {track.album?.name}</p>
            <div className="w-full mt-5 slider-wrap">
              <input data-seeking="1" type="range" min={0} max={duration || 0} step={0.5} value={currentTime}
                onChange={(e) => seekTo(Number(e.target.value))} className="slider w-full" aria-label="Seek" />
              <div className="flex justify-between text-xs text-dim mt-1"><span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span></div>
            </div>
            <div className="flex items-center gap-5 mt-3">
              <button onClick={toggleShuffle} className={`text-xl ${shuffle ? 'accent' : 'text-dim'}`} aria-label="Shuffle" title="Shuffle">🔀</button>
              <button onClick={prev} className="text-3xl" aria-label="Previous">⏮</button>
              <button onClick={togglePlay} className="w-16 h-16 rounded-full btn-accent grid place-items-center text-2xl" aria-label={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? '⏸' : '▶'}</button>
              <button onClick={next} className="text-3xl" aria-label="Next">⏭</button>
              <button onClick={cycleRepeat} className={`text-xl ${repeat !== 'off' ? 'accent' : 'text-dim'}`} aria-label="Repeat" title={`Repeat: ${repeat}`}>{repeat === 'one' ? '🔂' : '🔁'}</button>
            </div>
            <div className="flex items-center gap-2 mt-4 w-full max-w-xs slider-wrap">
              <button onClick={() => setMuted(!muted)} aria-label="Mute">{muted || volume === 0 ? '🔇' : '🔊'}</button>
              <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => setVolume(Number(e.target.value))} className="slider flex-1" aria-label="Volume" />
            </div>
            <div className="flex items-center gap-2 mt-5 flex-wrap justify-center">
              <button onClick={() => toggleLike(track)} className={`px-4 py-2 rounded-full text-sm font-bold ${isLiked ? 'bg-accent text-black' : 'bg-white/10'}`}>{isLiked ? '♥ Liked' : '♡ Like'}</button>
              <div className="relative">
                <button onClick={() => setShowPlMenu(v => !v)} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10">＋ Playlist</button>
                {showPlMenu && <div className="absolute bottom-12 left-0 z-10"><AddToPlaylistMenu track={track} onDone={() => setShowPlMenu(false)} /></div>}
              </div>
              <button onClick={share} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10">↗ Share</button>
              <button onClick={() => { toggleDownload(track); toast(downloads[track.id] ? 'Removed from offline' : 'Saved for offline'); }} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10">
                {downloads[track.id] ? '✓ Offline' : '⬇ Offline'}
              </button>
              <div className="relative">
                <button onClick={() => setShowSleep(v => !v)} className={`px-4 py-2 rounded-full text-sm font-bold ${sleepTimerMin ? 'bg-accent text-black' : 'bg-white/10'}`}>
                  ⏾ {sleepTimerMin ? `${sleepTimerMin}m` : 'Sleep'}
                </button>
                {showSleep && (
                  <div className="card absolute bottom-12 left-0 p-2 w-40">
                    {[0, 5, 10, 15, 30, 45, 60].map(m => (
                      <button key={m} onClick={() => { setSleepTimer(m); setShowSleep(false); toast(m ? `Sleep timer: ${m} min` : 'Sleep timer off'); }}
                        className="w-full text-left px-2 py-1.5 rounded-lg text-sm bg-hoverable">{m === 0 ? 'Off' : `${m} minutes`}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="card p-4 min-h-[300px]">
            <div className="flex gap-2 mb-3 overflow-x-auto no-scrollbar">
              {[['lyrics', 'Lyrics'], ['studio', '🎚️ Studio'], ['info', 'Details']].map(([t, label]) => (
                <button key={t} onClick={() => setTab(t)} className={`px-4 py-1.5 rounded-full text-sm font-bold shrink-0 ${tab === t ? 'bg-accent text-black' : 'bg-white/10'}`}>{label}</button>
              ))}
            </div>
            {tab === 'lyrics' ? <Lyrics track={track} /> : tab === 'studio' ? <Equalizer /> : (
              <div className="text-sm flex flex-col gap-2">
                <p><b>Title:</b> {track.title}</p>
                <p><b>Artist:</b> {track.artist?.name}</p>
                <p><b>Album:</b> {track.album?.name} {track.album?.year && `(${track.album.year})`}</p>
                <p><b>Duration:</b> {formatTime(track.duration)}</p>
                <p><b>Source:</b> {track.source}{track.isPreview ? ' (30s preview)' : ' (full track)'}</p>
                {track.codec && <p><b>Codec:</b> {track.codec.toUpperCase()}{track.quality ? ` · ${track.quality}kbps` : ''}</p>}
                {track.language && <p><b>Language:</b> {track.language}</p>}
                {track.playCount > 0 && <p><b>Plays:</b> {Number(track.playCount).toLocaleString()}</p>}
              </div>
            )}
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
  const clearQueue = useStore(s => s.clearQueue);
  const playTracks = useStore(s => s.playTracks);
  if (!show) return null;
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-label="Queue">
      <div className="absolute inset-0 bg-black/60" onClick={() => setShow(false)} />
      <div className="absolute right-0 top-0 bottom-0 w-full max-w-md bg-soft border-l border-soft p-4 overflow-y-auto fade-up">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-extrabold">Up Next ({queue.length})</h2>
          <div className="flex gap-2">
            <button onClick={() => { clearQueue(); setShow(false); }} className="text-xs font-bold px-3 py-1.5 rounded-full bg-white/10">Clear</button>
            <button onClick={() => setShow(false)} className="text-xl px-2" aria-label="Close queue">✕</button>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {queue.map((t, i) => (
            <div key={`${t.id}-${i}`} className={`flex items-center gap-2 p-1.5 rounded-lg ${i === index ? 'bg-accent/10' : ''}`}>
              <button onClick={() => { playTracks(queue, i); }} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                <Img src={t.image || t.thumbnails?.small} alt="" className="w-10 h-10 rounded object-cover" />
                <span className="min-w-0"><p className="truncate text-sm font-semibold">{t.title}</p><p className="truncate text-xs text-dim">{t.artist?.name}</p></span>
              </button>
              {i === index && <span className="text-xs accent font-bold">PLAYING</span>}
              <button onClick={() => removeFromQueue(i)} className="text-dim px-2" aria-label="Remove from queue">✕</button>
            </div>
          ))}
          {queue.length === 0 && <p className="text-sm text-dim">Queue is empty. Play something!</p>}
        </div>
      </div>
    </div>
  );
}
