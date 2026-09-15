import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { SongRow, AlbumCard, ArtistCard, PlaylistCard } from '../components/Cards';

export function LikedSongs() {
  const liked = useStore(s => s.liked);
  const playTracks = useStore(s => s.playTracks);
  const songs = Object.values(liked);
  const [sort, setSort] = useState('recent');
  const sorted = [...songs].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : 0);

  return (
    <div className="pb-8">
      <div className="flex items-center gap-5 hero-gradient rounded-2xl p-6 border border-soft">
        <div className="w-32 h-32 rounded-2xl grid place-items-center text-6xl shrink-0" style={{ background: 'linear-gradient(135deg,#450af5,#c4efd9)' }}>♥</div>
        <div>
          <p className="text-xs font-bold tracking-widest">PLAYLIST</p>
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight">Liked Songs</h1>
          <p className="text-sm text-dim mt-1">{songs.length} songs</p>
          {songs.length > 0 && <button onClick={() => playTracks(sorted, 0)} className="btn-accent px-6 py-2.5 text-sm mt-3">▶ Play all</button>}
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
  const playTracks = useStore(s => s.playTracks);
  const toast = useStore(s => s.toast);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const pl = playlists.find(p => p.id === decodeURIComponent(id || ''));

  if (!pl) return <div className="p-8 text-center"><p className="font-bold text-lg">Playlist not found</p><Link to="/library" className="accent text-sm font-bold">← Back to library</Link></div>;

  const mosaic = pl.tracks.slice(0, 4);
  return (
    <div className="pb-8">
      <div className="flex items-center gap-5 hero-gradient rounded-2xl p-6 border border-soft flex-wrap">
        {mosaic.length >= 4 ? (
          <div className="grid grid-cols-2 gap-[2px] w-32 h-32 rounded-2xl overflow-hidden shrink-0">
            {mosaic.map(t => <img key={t.id} src={t.image} alt="" className="w-full h-full object-cover" />)}
          </div>
        ) : <div className="w-32 h-32 rounded-2xl bg-soft grid place-items-center text-5xl shrink-0">🎵</div>}
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
              <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight">{pl.name}</h1>
              {pl.description && <p className="text-sm text-dim">{pl.description}</p>}
              <p className="text-sm text-dim mt-1">{pl.tracks.length} songs</p>
            </>
          )}
          <div className="flex gap-2 mt-3 flex-wrap">
            {pl.tracks.length > 0 && <button onClick={() => playTracks(pl.tracks, 0)} className="btn-accent px-6 py-2 text-sm">▶ Play</button>}
            {!editing && <button onClick={() => { setName(pl.name); setDesc(pl.description || ''); setEditing(true); }} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10">✎ Edit</button>}
            <button onClick={async () => { try { await navigator.clipboard.writeText(location.href); toast('Playlist link copied'); } catch {} }} className="px-4 py-2 rounded-full text-sm font-bold bg-white/10">↗ Share</button>
          </div>
        </div>
      </div>
      <div className="card p-2 mt-4 flex flex-col">
        {pl.tracks.map((t, i) => <SongRow key={t.id} track={t} index={i} context={pl.tracks} onRemove={() => removeFromPlaylist(pl.id, t.id)} />)}
        {pl.tracks.length === 0 && <p className="p-6 text-sm text-dim text-center">Empty playlist — add songs from the full player (＋ Playlist).</p>}
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
  const toast = useStore(s => s.toast);
  const [filter, setFilter] = useState('');

  const likedSongs = Object.values(liked);
  const offlineSongs = likedSongs.concat(history).filter(t => downloads[t.id]);
  const f = filter.toLowerCase();
  const matchPlaylists = playlists.filter(p => p.name.toLowerCase().includes(f));

  return (
    <div className="pb-8">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight">Your Library</h1>
        <div className="flex gap-2">
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter library…" className="bg-soft border border-soft rounded-full px-4 py-1.5 text-sm outline-none" aria-label="Filter library" />
          <button onClick={() => { const n = prompt('Playlist name:'); if (n?.trim()) { createPlaylist(n.trim()); toast('Playlist created'); } }} className="btn-accent px-4 py-1.5 text-sm">＋ New</button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-5">
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
        <><h2 className="text-xl font-extrabold mt-8 mb-3">⬇ Offline Songs ({offlineSongs.length})</h2>
          <div className="card p-2 flex flex-col">{offlineSongs.map((t, i) => <SongRow key={t.id} track={t} index={i} context={offlineSongs} />)}</div></>
      )}
      <div className="flex items-center justify-between mt-8 mb-3">
        <h2 className="text-xl font-extrabold">Recently Played</h2>
        {history.length > 0 && <button onClick={clearHistory} className="text-xs font-bold text-dim">CLEAR</button>}
      </div>
      <div className="card p-2 flex flex-col">
        {history.slice(0, 20).map((t, i) => <SongRow key={t.id} track={t} index={i} context={history} />)}
        {history.length === 0 && <p className="p-6 text-sm text-dim text-center">Nothing yet — go play something! 🎧</p>}
      </div>
    </div>
  );
}
