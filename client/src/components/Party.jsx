import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { api } from '../services/musicApi';
import { CloseIcon } from './Icons';

/** Listen Together (Echo-style): host a synced party or join one with a code. */
export default function PartyPanel() {
  const show = useStore(s => s.showParty);
  const setShow = useStore(s => s.setShowParty);
  const party = useStore(s => s.party);
  const startParty = useStore(s => s.startParty);
  const joinParty = useStore(s => s.joinParty);
  const leaveParty = useStore(s => s.leaveParty);
  const queue = useStore(s => s.queue);
  const index = useStore(s => s.index);
  const toast = useStore(s => s.toast);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!show) return;
    const onKey = (e) => { if (e.key === 'Escape') setShow(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, setShow]);
  if (!show) return null;
  const track = index >= 0 ? queue[index] : null;

  const start = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.party.create();
      startParty(r.code);
      toast(`Party ${r.code} live — guests hear what you play`);
    } catch { setError('Could not start a party. Try again.'); }
    setBusy(false);
  };
  const join = async () => {
    const c = code.trim().toUpperCase();
    if (c.length !== 6) { setError('Enter the 6-character party code.'); return; }
    setBusy(true); setError('');
    try {
      const room = await api.party.get(c);
      if (room?.ended) { setError('Party not found or ended.'); }
      else { joinParty(c); toast(`Joined party ${c} — following host`); }
    } catch { setError('Could not join. Try again.'); }
    setBusy(false);
  };
  const stop = async () => {
    if (party?.role === 'host') { try { await api.party.end(party.code); } catch { /* noop */ } }
    leaveParty();
    setShow(false);
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-label="Listen Together">
      <div className="absolute inset-0 bg-black/60" onClick={() => setShow(false)} aria-hidden />
      <div className="panel relative w-full max-w-sm p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-extrabold">Listen Together</h2>
          <button onClick={() => setShow(false)} className="p-2 text-dim hover:text-white" aria-label="Close party panel"><CloseIcon size={18} /></button>
        </div>
        {!party && (
          <>
            <p className="text-xs text-dim font-semibold mb-4">Host a party and guests hear your music in sync.</p>
            <button onClick={start} disabled={busy} className="btn-accent w-full py-2.5 text-sm disabled:opacity-40" aria-label="Start a party">
              {busy ? 'Starting…' : 'Start a party'}
            </button>
            <div className="flex items-center gap-3 my-4" aria-hidden>
              <div className="h-px flex-1 bg-white/10" /><span className="text-[11px] font-bold text-dim">OR JOIN</span><div className="h-px flex-1 bg-white/10" />
            </div>
            <div className="flex gap-2">
              <input value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                onKeyDown={e => { if (e.key === 'Enter') join(); }}
                placeholder="CODE" aria-label="Party code" enterKeyHint="go"
                className="flex-1 min-w-0 bg-soft border border-soft rounded-xl px-4 py-2.5 text-sm font-extrabold tracking-[0.3em] text-center outline-none focus:border-green-500" />
              <button onClick={join} disabled={busy} className="px-5 py-2 rounded-xl text-sm font-bold bg-white/10 disabled:opacity-40" aria-label="Join party">Join</button>
            </div>
            {error && <p className="mt-3 text-xs font-bold text-red-400" role="alert">{error}</p>}
          </>
        )}
        {party?.role === 'host' && (
          <>
            <p className="text-xs text-dim font-semibold">Share this code with your guests</p>
            <p className="my-3 text-center text-4xl font-black tracking-[0.25em] accent" aria-label="Party code display">{party.code}</p>
            <p className="text-xs text-dim font-semibold flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" aria-hidden />
              {track ? `Hosting · ${track.title}` : 'Hosting · play something and guests will follow'}
            </p>
            <button onClick={stop} className="mt-4 w-full py-2.5 rounded-xl text-sm font-bold bg-white/10" aria-label="Stop party">Stop party</button>
          </>
        )}
        {party?.role === 'guest' && (
          <>
            <p className="text-xs text-dim font-semibold flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" aria-hidden />
              {`Following host · ${party.code}`}
            </p>
            <p className="mt-2 text-sm font-bold">{track ? track.title : 'Waiting for the host to play…'}</p>
            {track?.artist?.name && <p className="text-xs text-dim font-semibold">{track.artist.name}</p>}
            <p className="mt-2 text-[11px] text-dim">Your playback follows the host. Leaving keeps your current queue.</p>
            <button onClick={stop} className="mt-4 w-full py-2.5 rounded-xl text-sm font-bold bg-white/10" aria-label="Leave party">Leave party</button>
          </>
        )}
      </div>
    </div>
  );
}
