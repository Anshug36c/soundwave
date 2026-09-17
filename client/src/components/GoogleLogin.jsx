import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/musicApi';
import { useStore } from '../store/useStore';

let cfgPromise = null;
function getConfig() {
  if (!cfgPromise) cfgPromise = api.auth.config().catch(() => ({ clientId: null }));
  return cfgPromise;
}

let gsiPromise = null;
function loadGsi() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gsiPromise) {
    gsiPromise = new Promise((resolve, reject) => {
      const done = () => resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = done;
      s.onerror = () => { gsiPromise = null; reject(new Error('gsi load failed')); };
      document.head.appendChild(s);
      setTimeout(() => reject(new Error('gsi timeout')), 15000);
    });
  }
  return gsiPromise;
}

export async function signOutEverywhere() {
  try { await api.auth.logout(); } catch { /* always clear local state */ }
  try { window.google?.accounts?.id?.disableAutoSelect?.(); } catch { /* noop */ }
  useStore.getState().logoutToGuest();
}

// Renders Google's official button. Returns null when the server has no
// GOOGLE_CLIENT_ID — parents show a setup hint instead.
export default function GoogleLogin() {
  const mountRef = useRef(null);
  const started = useRef(false);
  const [state, setState] = useState('loading'); // loading | ready | missing | error
  const loginWithGoogle = useStore(s => s.loginWithGoogle);
  const toast = useStore(s => s.toast);

  useEffect(() => {
    if (started.current) return; // StrictMode double-mount: render the button once
    started.current = true;
    let dead = false;
    (async () => {
      try {
        const { clientId } = await getConfig();
        if (!clientId) { if (!dead) setState('missing'); return; }
        await loadGsi();
        if (dead || !mountRef.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async (resp) => {
            try {
              const { user } = await api.auth.google(resp.credential);
              loginWithGoogle(user);
            } catch (e) {
              toast(e.status === 501 ? 'Google sign-in is not configured on the server' : 'Google sign-in failed', 'error');
            }
          },
        });
        window.google.accounts.id.renderButton(mountRef.current, {
          theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 260,
        });
        if (!dead) setState('ready');
      } catch { if (!dead) setState('error'); }
    })();
    return () => { dead = true; started.current = false; };
  }, [loginWithGoogle, toast]);

  if (state === 'missing') return <p className="text-xs text-dim font-semibold">Google sign-in isn&apos;t set up on this server yet.</p>;
  if (state === 'error') return <p className="text-xs text-dim">Could not load Google sign-in (offline?).</p>;
  return (
    <span>
      {state === 'loading' && <span className="text-xs text-dim font-bold">Loading Google sign-in…</span>}
      <span ref={mountRef} className={state === 'loading' ? 'hidden' : 'inline-block'} />
    </span>
  );
}

// Top-bar avatar: guest -> settings link; signed-in -> photo + account menu.
export function AuthAvatar() {
  const profile = useStore(s => s.profile);
  const authUser = useStore(s => s.authUser);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open ]);

  if (!authUser) {
    return (
      <Link to="/settings" className="h-9 px-4 rounded-full bg-accent grid place-items-center font-bold text-black text-sm shrink-0" aria-label="Sign in" title="Sign in with Google">
        Sign in
      </Link>
    );
  }
  return (
    <div className="relative shrink-0">
      <button onClick={() => setOpen(v => !v)} aria-label="Account" aria-haspopup="menu" aria-expanded={open} title={authUser.email}>
        {profile.picture
          ? <img src={profile.picture} alt="" referrerPolicy="no-referrer" className="w-9 h-9 rounded-full object-cover" />
          : <span className="w-9 h-9 rounded-full bg-accent grid place-items-center font-bold text-black">{(profile.name?.[0] || 'G').toUpperCase()}</span>}
      </button>
      {open && (
        <>
          <button className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} aria-label="Close account menu" tabIndex={-1} />
          <div role="menu" aria-label="Account" className="absolute right-0 mt-2 w-64 panel p-3 z-40">
            <p className="font-bold text-sm truncate">{profile.name}</p>
            <p className="text-xs text-dim truncate mb-2">{profile.email}</p>
            <p className="text-[11px] text-dim mb-3">Your library on this device is kept separate for this account.</p>
            <div className="flex gap-2">
              <Link to="/settings" onClick={() => setOpen(false)} className="flex-1 text-center chip">Settings</Link>
              <button onClick={() => { setOpen(false); signOutEverywhere(); }} className="flex-1 chip">Sign out</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
