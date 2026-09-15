import { useState } from 'react';
import { useStore } from '../store/useStore';

function Row({ label, desc, children }) {
  return (
    <div className="card p-4 flex items-center justify-between gap-4 flex-wrap">
      <div><p className="font-bold text-sm">{label}</p>{desc && <p className="text-xs text-dim">{desc}</p>}</div>
      {children}
    </div>
  );
}

export default function Settings() {
  const theme = useStore(s => s.theme);
  const setTheme = useStore(s => s.setTheme);
  const quality = useStore(s => s.quality);
  const setQuality = useStore(s => s.setQuality);
  const formatPref = useStore(s => s.formatPref);
  const setFormatPref = useStore(s => s.setFormatPref);
  const profile = useStore(s => s.profile);
  const setProfile = useStore(s => s.setProfile);
  const history = useStore(s => s.history);
  const liked = useStore(s => s.liked);
  const playlists = useStore(s => s.playlists);
  const followedArtists = useStore(s => s.followedArtists);
  const clearHistory = useStore(s => s.clearHistory);
  const toast = useStore(s => s.toast);
  const [name, setName] = useState(profile.name);
  const [deferred, setDeferred] = useState(null);

  useState(() => {
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); setDeferred(e); });
  });

  const topArtists = {};
  history.forEach(t => { const n = t.artist?.name || 'Unknown'; topArtists[n] = (topArtists[n] || 0) + 1; });
  const topList = Object.entries(topArtists).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="pb-8 max-w-2xl">
      <h1 className="text-2xl font-extrabold tracking-tight">Profile & Settings</h1>

      <div className="card p-5 mt-4 flex items-center gap-4">
        <div className="w-16 h-16 rounded-full bg-accent grid place-items-center text-2xl font-extrabold text-black shrink-0">
          {(profile.name?.[0] || 'G').toUpperCase()}
        </div>
        <div className="flex-1">
          <form onSubmit={(e) => { e.preventDefault(); setProfile({ name: name || 'Guest Listener' }); toast('Profile updated'); }} className="flex gap-2">
            <input value={name} onChange={e => setName(e.target.value)} className="flex-1 min-w-0 bg-soft border border-soft rounded-lg px-3 py-2 font-bold outline-none" aria-label="Display name" />
            <button className="btn-accent px-4 text-sm">Save</button>
          </form>
          <div className="flex gap-4 mt-2 text-xs text-dim font-semibold">
            <span>❤️ {Object.keys(liked).length} liked</span>
            <span>🎵 {playlists.length} playlists</span>
            <span>👥 {Object.keys(followedArtists).length} following</span>
            <span>▶ {history.length} played</span>
          </div>
        </div>
      </div>

      {topList.length > 0 && (
        <div className="card p-4 mt-3">
          <p className="font-bold text-sm mb-2">Your top artists</p>
          {topList.map(([n, c], i) => (
            <div key={n} className="flex items-center gap-2 text-sm py-1">
              <span className="text-dim w-5">{i + 1}.</span><span className="font-semibold flex-1">{n}</span>
              <div className="w-32 h-1.5 bg-white/10 rounded-full"><div className="h-full bg-accent rounded-full" style={{ width: `${(c / topList[0][1]) * 100}%` }} /></div>
              <span className="text-xs text-dim">{c} plays</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 mt-4">
        <Row label="Appearance" desc="Dark or light theme">
          <div className="flex gap-2">
            {['dark', 'light'].map(t => <button key={t} onClick={() => setTheme(t)} className={`px-4 py-1.5 rounded-full text-sm font-bold capitalize ${theme === t ? 'bg-accent text-black' : 'bg-white/10'}`}>{t}</button>)}
          </div>
        </Row>
        <Row label="Audio quality" desc="High = 320kbps where available">
          <div className="flex gap-2">
            {['low', 'medium', 'high'].map(q => <button key={q} onClick={() => { setQuality(q); toast(`Quality: ${q}`); }} className={`px-4 py-1.5 rounded-full text-sm font-bold capitalize ${quality === q ? 'bg-accent text-black' : 'bg-white/10'}`}>{q}</button>)}
          </div>
        </Row>
        <Row label="YouTube Music format" desc="Opus (WebM) = best quality · Auto picks the best available">
          <div className="flex gap-2">
            {[['auto', 'Auto'], ['opus', 'Opus'], ['m4a', 'M4A']].map(([v, l]) => <button key={v} onClick={() => { setFormatPref(v); toast(`YT Music: ${l}`); }} className={`px-4 py-1.5 rounded-full text-sm font-bold ${formatPref === v ? 'bg-accent text-black' : 'bg-white/10'}`}>{l}</button>)}
          </div>
        </Row>
        <Row label="Install app" desc="Add SoundWave to your home screen (PWA)">
          <button onClick={async () => { if (deferred) { deferred.prompt(); await deferred.userChoice; setDeferred(null); } else toast('Use browser menu → Install/Add to Home Screen'); }} className="btn-accent px-4 py-1.5 text-sm">📲 Install</button>
        </Row>
        <Row label="Listening history" desc={`${history.length} tracks stored locally`}>
          <button onClick={() => { clearHistory(); toast('History cleared'); }} className="px-4 py-1.5 rounded-full text-sm font-bold bg-white/10">Clear</button>
        </Row>
        <Row label="Storage" desc="Offline songs live in cache storage">
          <button onClick={async () => {
            try {
              const keys = await caches.keys();
              await Promise.all(keys.filter(k => k.includes('audio')).map(k => caches.delete(k)));
              toast('Offline cache cleared');
            } catch { toast('Could not clear cache', 'error'); }
          }} className="px-4 py-1.5 rounded-full text-sm font-bold bg-white/10">Clear offline songs</button>
        </Row>
        <Row label="Keyboard shortcuts" desc="Space play/pause · ←/→ seek · ↑/↓ volume · M mute · N/P next/prev">
          <span className="text-xs text-dim font-bold">⌨️ Built-in</span>
        </Row>
      </div>

      <p className="text-xs text-dim mt-6 leading-5">
        SoundWave streams via JioSaavn (full tracks where reachable), iTunes + Deezer (previews/charts), AudioDB/MusicBrainz (artist data) & Lyrics.ovh.
        Add <code>SPOTIFY_CLIENT_ID/SECRET</code> and <code>LASTFM_API_KEY</code> in <code>.env</code> to enable enriched metadata.
        Made with ♥ as a demo — respect artists & rights holders.
      </p>
    </div>
  );
}
