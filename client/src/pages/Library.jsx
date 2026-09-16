import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { shuffleList, timeAgo } from '../services/musicApi';
import { SongRow, AlbumCard, ArtistCard, PlaylistCard } from '../components/Cards';
import { PlayIcon, ShareIcon, PlusIcon, DownloadIcon, NoteIcon, PencilIcon } from '../components/Icons';

export function LikedSongs() {
  const liked = useStore(s => s.liked);
  const playTracks = useStore(s => s.playTracks);
  const songs = Object.values(liked);
  const [sort, setSort] = useState('recent');
  const sorted = [...songs].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : (b._likedAt || 0) - (a._likedAt || 0));

  return (
    <div className="pb-8">
      <div className="flex items-center gap-4 p-4 sm:gap-5 sm:p-6 hero-gradient rounded-2xl border border-soft flex-wrap">
        <div className="w-24 h-24 sm:w-32 sm:h-32 rounded-2xl grid place-items-center text-5xl sm:text-6xl shrink-0" style={{ background: 'linear-gradient(135deg,#450af5,#c4efd9)' }}>♥</div>
        <div>
          <p className="text-xs font-bold tracking-widest">PLAYLIST</p>
          <h1 className="text-2xl sm:text-3xl md:text-5xl font-extrabold tracking-tight">Liked Songs</h1>
          <p className="text-sm text-dim mt-1">{songs.length} songs</p>
          {songs.length > 0 && <span className="flex gap-2 mt-3"><button onClick={() => playTracks(sorted, 0)} className="btn-accent px-6 py-2.5 text-sm inline-flex items-center gap-1.5"><PlayIcon size={15} />Play all</button><button onClick={() => playTracks(shuffleList(sorted), 0)} className="px-5 py-2.5 rounded-full text-sm font-bold bg-white/10">Shuffle</button></span>}
        </div>
      </div>
      <div className="flex justify-end mt-4">
        <select value={sort} onChange={e => setSort(e.target.value)} className="bg-soft border border-soft rounded-lg px-2 py-1.5 text-sm" aria-label="Sort">
          <option value="recent">Recently added</option>
          <option value="title">Title A–Z</option>
        </select>
      </div>
      <div className="card p-2 mt-3 flex flex-col">
        {sorted.map((t, i) => <SongRow key={t.id} track={t} index={i} context={sorted} />)}
        {sorted.length === 0 && <p className="p-6 text-sm text-dim text-center">Songs you like will appear here. Tap ♡ on any track!</p>}
      </div>
    </div>
  );
}

export function LocalPlaylist() {
  const { id } = useParams();
  const playlists = useStore(s => s.playlists);
  const renamePlaylist = useStore(s => s.renamePlaylist);
  const deletePlaylist = useStore(s => s.deletePlaylist);
  const removeFromPlaylist = useStore(s => s.removeFromPlaylist);
  const reorderPlaylist = useStore(s => s.reorderPlaylist);
  const playTracks = useStore(s => s.playTracks);
  const toast = useStore(s => s.toast);
  const exportJSON = () => {
    try {
      const blob = new Blob([JSON.stringify({ app: 'soundwave', name: pl.name, description: pl.description || '', tracks: pl.tracks }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${pl.name.replace(/[^a-z0-9]+/gi, '-')}.soundwave.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Playlist exported');
    } catch { toast('Export failed', 'error'); }
  };
  const sharePlaylist = async () => {
    try {
      if (navigator.share) await navigator.share({ title: pl.name, text: `${pl.name} — SoundWave playlist`, url: location.href });
      else { await navigator.clipboard.writeText(location.href); toast('Playlist link copied'); }
    } catch { /* dismissed */ }
  };
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const pl = playlists.find(p => p.id === decodeURIComponent(id || ''));

  if (!pl) return <div className="p-8 text-center"><p className="font-bold text-lg">Playlist not found</p><Link to="/library" className="accent text-sm font-bold">← Back to library</Link></div>;

  const mosaic = pl.tracks.slice(0, 4);
  return (
    <div className="pb-8">
      <div className="flex items-center gap-4 p-4 sm:gap-5 sm:p-6 hero-gradient rounded-2xl border border-soft flex-wrap">
        {mosaic.length >= 4 ? (
          <div className="grid grid-cols-2 gap-[2px] w-28 h-28 sm:w-32 sm:h-32 rounded-2xl overflow-hidden shrink-0">
            {mosaic.map(t => <img key={t.id} src={t.image} alt="" className="w-full h-full object-cover" />)}
          </div>
        ) : <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-2xl bg-soft grid place-items-center shrink-0"><NoteIcon size={40} className="text-dim" /></div>}
        <div className="min-w-0">
          <p className="text-xs font-bold tracking-widest">PLAYLIST · {pl.isPublic ? 'PUBLIC' : 'PRIVATE'}</p>
          {editing ? (
            <form onSubmit={(e) => { e.preventDefault(); renamePlaylist(pl.id, name || pl.name, desc); setEditing(false); toast('Playlist updated'); }} className="flex flex-col gap-2 mt-1">
              <input value={name} onChange={e => setName(e.target.value)} placeholder={pl.name} className="bg-soft border border-soft rounded-lg px-3 py-1.5 font-bold" />
              <input value={desc} onChange={e => setDesc(e.target.value)} placeholder={pl.description || 'Description'} className="bg-soft border border-soft rounded-lg px-3 py-1.5 text-sm" />
              <div className="flex gap-2"><button className="btn-accent px-4 py-1.5 text-sm">Save</button>
                <button type="button" onClick={() => setEditing(false)} className="px-4 py-1.5 rounded-full text-sm font-bold bg-white/10">Cancel</button></div>
            </form>
          ) : (
            <>
              <h1 className="text-2xl sm:text-3xl md:text-5xl font-extrabold tracking-tight">{pl.name}</h1>
              {pl.description && <p className="text-sm text-dim">{pl.description}</p>}
              <p className="text-sm text-dim mt-1">{pl.tracks.length} songs</p>
            </>
          )}
          <div className="flex gap-2 mt-3 flex-wrap">
            {pl.tracks.length > 0 && <button onClick={() => playTracks(pl.tracks, 0)} className="btn-accent px-6 py-2 text-sm inline-flex items-center gap-1.5"><PlayIcon size={15} />Play</button>}
            {pl.tracks.length > 0 && <button onClick={() => playTracks(shuffleList(pl.tracks), 0)} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10">Shuffle</button>}
            {!editing && <button onClick={() => { setName(pl.name); setDesc(pl.description || ''); setEditing(true); }} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10 inline-flex items-center gap-1.5"><PencilIcon size={15} />Edit</button>}
            <button onClick={sharePlaylist} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10 inline-flex items-center gap-1.5"><ShareIcon size={15} />Share</button>
            <button onClick={exportJSON} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10 inline-flex items-center gap-1.5"><DownloadIcon size={15} />Export</button>
          </div>
        </div>
      </div>
      <div className="card p-2 mt-4 flex flex-col">
        {pl.tracks.map((t, i) => <SongRow key={t.id} track={t} index={i} context={pl.tracks} onRemove={() => removeFromPlaylist(pl.id, t.id)} onMoveUp={i > 0 ? () => reorderPlaylist(pl.id, i, i - 1) : undefined} onMoveDown={i < pl.tracks.length - 1 ? () => reorderPlaylist(pl.id, i, i + 1) : undefined} />)}
        {pl.tracks.length === 0 && <p className="p-6 text-sm text-dim text-center">Empty playlist — add songs from the full player.</p>}
      </div>
      <button onClick={() => { if (confirm('Delete this playlist?')) { deletePlaylist(pl.id); history.back(); } }} className="mt-4 text-sm font-bold text-red-500">Delete playlist</button>
    </div>
  );
}

export default function Library() {
  const playlists = useStore(s => s.playlists);
  const liked = useStore(s => s.liked);
  const followedArtists = useStore(s => s.followedArtists);
  const savedAlbums = useStore(s => s.savedAlbums);
  const history = useStore(s => s.history);
  const downloads = useStore(s => s.downloads);
  const clearHistory = useStore(s => s.clearHistory);
  const createPlaylist = useStore(s => s.createPlaylist);
  const addToPlaylist = useStore(s => s.addToPlaylist);
  const playTracks = useStore(s => s.playTracks);
  const playCounts = useStore(s => s.playCounts);
  const toast = useStore(s => s.toast);
  const [filter, setFilter] = useState('');

  const likedSongs = Object.values(liked);
  const mostPlayed = Object.values(playCounts).sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 10);
  const importFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const j = JSON.parse(rd.result);
        const tracks = (j.tracks || []).filter(t => t?.id);
        if (!tracks.length) { toast('No songs in that file', 'error'); return; }
        const id = createPlaylist(j.name || f.name.replace(/\.json$/i, ''), j.description || '');
        tracks.forEach(t => addToPlaylist(id, t));
        toast(`Imported ${tracks.length} songs`);
      } catch { toast('Could not read that file', 'error'); }
    };
    rd.readAsText(f);
  };
  const offlineSongs = likedSongs.concat(history).filter(t => downloads[t.id]);
  const f = filter.toLowerCase();
  const matchPlaylists = playlists.filter(p => p.name.toLowerCase().includes(f));

  return (
    <div className="pb-8">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight">Your Library</h1>
        <div className="flex gap-2">
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter library…" className="bg-soft border border-soft rounded-full px-4 py-1.5 text-sm outline-none" aria-label="Filter library" />
          <label className="px-4 py-2 rounded-full text-sm font-bold bg-white/10 inline-flex items-center gap-1 cursor-pointer"><DownloadIcon size={15} />Import<input type="file" accept=".json,application/json" className="hidden" onChange={importFile} /></label>
          <button onClick={() => { const n = prompt('Playlist name:'); if (n?.trim()) { createPlaylist(n.trim()); toast('Playlist created'); } }} className="btn-accent px-4 py-2 text-sm inline-flex items-center gap-1"><PlusIcon size={15} />New</button>
        </div>
      </div>

      {history.length > 0 && history[0] && (
        <button onClick={() => playTracks(history, 0)} className="mt-5 w-full card p-4 text-left flex items-center gap-3">
          <span className="w-11 h-11 rounded-full btn-accent grid place-items-center shrink-0"><PlayIcon size={18} /></span>
          <span className="min-w-0"><span className="block text-xs font-bold text-dim">CONTINUE LISTENING</span>
            <span className="block truncate font-bold">{history[0].title} — {history[0].artist?.name}</span></span>
        </button>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-5 [&>*]:min-w-0 [&>*]:max-w-none">
        <PlaylistCard playlist={{ id: '__liked__', name: 'Liked Songs', tracks: likedSongs, image: '' }} to="/liked" />
        {matchPlaylists.map(p => <PlaylistCard key={p.id} playlist={p} />)}
      </div>

      {Object.values(savedAlbums).length > 0 && (
        <><h2 className="text-xl font-extrabold mt-8 mb-3">Saved Albums</h2>
          <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">{Object.values(savedAlbums).map(a => <AlbumCard key={a.id} album={a} />)}</div></>
      )}
      {Object.values(followedArtists).length > 0 && (
        <><h2 className="text-xl font-extrabold mt-8 mb-3">Followed Artists</h2>
          <div className="flex gap-3 overflow-x-auto no-scrollbar pb-2">{Object.values(followedArtists).map(a => <ArtistCard key={a.id} artist={a} />)}</div></>
      )}
      {offlineSongs.length > 0 && (
        <><h2 className="text-xl font-extrabold mt-8 mb-3"><DownloadIcon size={19} className="inline -mt-0.5 mr-1" />Offline Songs ({offlineSongs.length})</h2>
          <div className="card p-2 flex flex-col">{offlineSongs.map((t, i) => <SongRow key={t.id} track={t} index={i} context={offlineSongs} />)}</div></>
      )}
      <div className="flex items-center justify-between mt-8 mb-3">
        <h2 className="text-xl font-extrabold">Recently Played</h2>
        {history.length > 0 && <button onClick={clearHistory} className="text-xs font-bold text-dim">CLEAR</button>}
      </div>
      <div className="card p-2 flex flex-col">
        {history.slice(0, 20).map((t, i) => <SongRow key={t.id} track={t} index={i} context={history} badge={timeAgo(t._playedAt)} />)}
        {history.length === 0 && <p className="p-6 text-sm text-dim text-center">Nothing yet — go play something!</p>}
      </div>
      {mostPlayed.length > 0 && (
        <><h2 className="text-xl font-extrabold mt-8 mb-3">Most Played</h2>
          <div className="card p-2 flex flex-col">
            {mostPlayed.map((e, i) => <SongRow key={e.track.id} track={e.track} index={i} context={mostPlayed.map(x => x.track)} badge={`${e.n} play${e.n > 1 ? 's' : ''}`} />)}
          </div></>
      )}
    </div>
  );
}
