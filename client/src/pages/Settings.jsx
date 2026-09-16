import { useState } from 'react';
import { useStore } from '../store/useStore';
import { diag } from '../services/musicApi';

function Diagnostics() {
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  if (!open) return <Row label="Diagnostics" desc="Local request & playback health — this session only, never uploaded"><button onClick={() => setOpen(true)} className="px-4 py-1.5 rounded-full text-sm font-bold bg-white/10">Show</button></Row>;
  const reqs = [...diag.reqs].reverse();
  const slow = reqs.filter(r => r.ms > 2000);
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="font-bold text-sm">Diagnostics <span className="text-xs text-dim font-semibold">(local, this session)</span></p>
        <span className="flex gap-2">
          <button onClick={() => setTick(t => t + 1)} className="px-3 py-1 rounded-full text-xs font-bold bg-white/10">Refresh</button>
          <button onClick={() => { diag.reset(); setTick(t => t + 1); }} className="px-3 py-1 rounded-full text-xs font-bold bg-white/10">Reset</button>
          <button onClick={() => setOpen(false)} className="px-3 py-1 rounded-full text-xs font-bold bg-white/10">Hide</button>
        </span>
      </div>
      <div className="flex gap-4 text-xs font-bold flex-wrap mb-2">
        <span>{diag.reqs.length} requests</span>
        <span className={diag.fails ? 'text-red-400' : ''}>{diag.fails} failed</span>
        <span>{diag.stalls} stalls</span>
        <span>{diag.skips} stall-skips</span>
      </div>
      {slow.length > 0 && <p className="text-xs text-dim mb-1">Slow (&gt;2s): {slow.slice(0, 5).map(r => `${r.p} ${(r.ms / 1000).toFixed(1)}s`).join(' · ')}</p>}
      <div className="max-h-40 overflow-y-auto sheet-scroll text-xs font-mono">
        {reqs.slice(0, 20).map((r, i) => (
          <div key={i} className={`flex justify-between gap-2 py-0.5 ${r.ok ? 'text-dim' : 'text-red-400'}`}><span className="truncate">{r.p}</span><span className="shrink-0">{r.ms}ms</span></div>
        ))}
        {!reqs.length && <p className="text-dim font-sans text-sm">No requests yet.</p>}
      </div>
    </div>
  );
}

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
  const studioOn = useStore(s => s.studioOn);
  const setStudioOn = useStore(s => s.setStudioOn);
  const crossfade = useStore(s => s.crossfade);
  const setCrossfade = useStore(s => s.setCrossfade);
  const instantPreview = useStore(s => s.instantPreview);
  const setInstantPreview = useStore(s => s.setInstantPreview);
  const profile = useStore(s => s.profile);
  const setProfile = useStore(s => s.setProfile);
  const history = useStore(s => s.history);
  const liked = useStore(s => s.liked);
  const playlists = useStore(s => s.playlists);
  const followedArtists = useStore(s => s.followedArtists);
  const clearHistory = useStore(s => s.clearHistory);
  const hiddenArtists = useStore(s => s.hiddenArtists);
  const unhideArtist = useStore(s => s.unhideArtist);
  const resetTaste = useStore(s => s.resetTaste);
  const disliked = useStore(s => s.disliked);
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

      <div className="card p-5 mt-4 flex items-center gap-4 flex-wrap">
        <div className="w-16 h-16 rounded-full bg-accent grid place-items-center text-2xl font-extrabold text-black shrink-0">
          {(profile.name?.[0] || 'G').toUpperCase()}
        </div>
        <div className="flex-1">
          <form onSubmit={(e) => { e.preventDefault(); setProfile({ name: name || 'Guest Listener' }); toast('Profile updated'); }} className="flex gap-2 flex-wrap">
            <input value={name} onChange={e => setName(e.target.value)} className="flex-1 min-w-0 bg-soft border border-soft rounded-lg px-3 py-2 font-bold outline-none" aria-label="Display name" />
            <button className="btn-accent px-4 text-sm">Save</button>
          </form>
          <div className="flex gap-x-4 gap-y-1 mt-2 text-xs text-dim font-semibold flex-wrap">
            <span>♥ {Object.keys(liked).length} liked</span>
            <span>♪ {playlists.length} playlists</span>
            <span>{Object.keys(followedArtists).length} following</span>
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
        <Row label="Appearance" desc="Dark · Light">
          <div className="flex gap-2">
            {[['dark', 'Dark'], ['light', 'Light']].map(([v, l]) => <button key={v} onClick={() => setTheme(v)} className={`px-4 py-1.5 rounded-full text-sm font-bold ${theme === v ? 'bg-accent' : 'bg-white/10'}`} style={theme === v ? { color: 'var(--accent-ink, #000)' } : {}}>{l}</button>)}
          </div>
        </Row>
        <Row label="Audio quality" desc="Auto picks a tier from your network speed · High = 320kbps · Medium = 128 · Low = 48 (auto-fallback when a tier is missing)">
          <div className="flex gap-2">
            {['auto', 'low', 'medium', 'high'].map(q => <button key={q} onClick={() => { setQuality(q); toast(`Quality: ${q}`); }} className={`px-4 py-1.5 rounded-full text-sm font-bold capitalize ${quality === q ? 'bg-accent' : 'bg-white/10'}`} style={quality === q ? { color: 'var(--accent-ink, #000)' } : {}}>{q}</button>)}
          </div>
        </Row>
        <Row label="Studio sound" desc="10-band EQ + live visualizer + normalize. Find it in the player → Studio tab.">
          <button onClick={() => { setStudioOn(!studioOn); toast(studioOn ? 'Studio sound off' : 'Studio sound on'); }} className={`px-5 py-1.5 rounded-full text-sm font-bold ${studioOn ? 'bg-accent' : 'bg-white/10'}`} style={studioOn ? { color: 'var(--accent-ink, #000)' } : {}}>{studioOn ? 'ON' : 'OFF'}</button>
        </Row>
        <Row label="Crossfade" desc="Smooth fade-out / fade-in between tracks">
          <button onClick={() => { setCrossfade(!crossfade); toast(`Crossfade ${!crossfade ? 'on' : 'off'}`); }} className={`px-5 py-1.5 rounded-full text-sm font-bold ${crossfade ? 'bg-accent' : 'bg-white/10'}`} style={crossfade ? { color: 'var(--accent-ink, #000)' } : {}}>{crossfade ? 'ON' : 'OFF'}</button>
        </Row>
        <Row label="Instant FLAC preview" desc="Play a 30s FLAC preview instantly, then auto-switch to the full MP3">
          <button onClick={() => { setInstantPreview(!instantPreview); toast(instantPreview ? 'Instant preview off' : 'Instant preview on'); }} className={`px-5 py-1.5 rounded-full text-sm font-bold ${instantPreview ? 'bg-accent' : 'bg-white/10'}`} style={instantPreview ? { color: 'var(--accent-ink, #000)' } : {}}>{instantPreview ? 'ON' : 'OFF'}</button>
        </Row>
        <Row label="Install app" desc="Add SoundWave to your home screen (PWA)">
          <button onClick={async () => { if (deferred) { deferred.prompt(); await deferred.userChoice; setDeferred(null); } else toast('Use browser menu → Install/Add to Home Screen'); }} className="btn-accent px-4 py-1.5 text-sm">Install</button>
        </Row>
        <Row label="Taste profile" desc={`${Object.keys(liked).length} liked · ${Object.keys(disliked).length} disliked · ${Object.keys(hiddenArtists).length} artists hidden`}>
          <button onClick={resetTaste} className="px-4 py-1.5 rounded-full text-sm font-bold bg-white/10">Reset taste</button>
        </Row>
        {Object.keys(hiddenArtists).length > 0 && (
        <Row label="Hidden artists" desc="Filtered from recommendations & song results">
          <span className="flex flex-wrap gap-1.5 justify-end">{Object.entries(hiddenArtists).map(([k, n]) => <button key={k} onClick={() => unhideArtist(k)} className="px-3 py-1 rounded-full text-xs font-bold bg-white/10" title="Unhide">{n} ✕</button>)}</span>
        </Row>
        )}
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
        <Row label="Privacy" desc="No account, no tracking. Likes, playlists, history & taste live only on this device; diagnostics never leave it.">
          <button onClick={async () => {
            if (!confirm('Delete ALL local data (likes, playlists, history, settings, offline songs)?')) return;
            try {
              localStorage.clear();
              const keys = await caches.keys();
              await Promise.all(keys.map(k => caches.delete(k)));
              if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
              }
            } catch { /* proceed to reload regardless */ }
            location.reload();
          }} className="px-4 py-1.5 rounded-full text-sm font-bold bg-red-500/15 text-red-400">Erase all local data</button>
        </Row>
        <Diagnostics />
        <Row label="Keyboard shortcuts" desc="Space play/pause · ←/→ seek · ↑/↓ volume · M mute · N/P next/prev · S shuffle · R repeat · Q queue · Ctrl+K palette">
          <span className="text-xs text-dim font-bold">Built-in</span>
        </Row>
      </div>

      <p className="text-xs text-dim mt-6 leading-5">
        SoundWave plays full MP3s from DJPunjab — every track is complete, no previews.
        Lyrics by Lyrics.ovh. Made with ♥ as a demo — respect artists & rights holders.
      </p>
    </div>
  );
}
