// SoundWave auth — Sign in with Google (Google Identity Services).
// Zero-dependency: verifies Google ID tokens with node:crypto against Google's
// public certs, then issues a first-party HS256 session JWT in an HttpOnly cookie.
// Identity only: the library stays on-device (namespaced per account client-side),
// so no database is needed. Set GOOGLE_CLIENT_ID (+ SESSION_SECRET) to enable.

import crypto from 'crypto';

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const SESSION_DAYS = 30;

export function getGoogleClientId() {
  return (process.env.GOOGLE_CLIENT_ID || '').trim() || null;
}

let bootSecret = null;
export function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!bootSecret) {
    bootSecret = crypto.randomBytes(32).toString('hex');
    console.warn('[auth] SESSION_SECRET unset — sessions die on restart. Set it in env for persistence.');
  }
  return bootSecret;
}

// ---------------- base64url ----------------
function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------- Google ID-token verification ----------------
let certCache = { keys: null, time: 0 };
async function fetchGoogleCerts() {
  if (certCache.keys && Date.now() - certCache.time < 3600000) return certCache.keys;
  const r = await fetch(GOOGLE_CERTS_URL, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`certs HTTP ${r.status}`);
  const j = await r.json();
  const keys = {};
  for (const k of j.keys || []) if (k.kid) keys[k.kid] = k;
  if (!Object.keys(keys).length) throw new Error('no certs');
  certCache = { keys, time: Date.now() };
  return keys;
}

export async function verifyGoogleIdToken(credential, { clientId, getCerts = fetchGoogleCerts } = {}) {
  const cid = clientId || getGoogleClientId();
  if (!cid) throw new Error('Google sign-in not configured');
  if (!credential || typeof credential !== 'string') throw new Error('missing credential');
  const parts = credential.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [hB64, pB64, sB64] = parts;
  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(hB64).toString('utf8'));
    payload = JSON.parse(b64urlDecode(pB64).toString('utf8'));
  } catch { throw new Error('malformed token'); }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('unexpected algorithm');

  let certs = await getCerts();
  let jwk = certs[header.kid];
  if (!jwk && getCerts === fetchGoogleCerts) {
    certCache = { keys: null, time: 0 }; // key rotation: refetch once
    certs = await getCerts();
    jwk = certs[header.kid];
  }
  if (!jwk) throw new Error('unknown key');
  let key;
  try {
    key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  } catch { throw new Error('bad key'); }
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${hB64}.${pB64}`), key, b64urlDecode(sB64));
  if (!ok) throw new Error('bad signature');

  if (!GOOGLE_ISSUERS.has(payload.iss)) throw new Error('bad issuer');
  if (payload.aud !== cid) throw new Error('bad audience');
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) throw new Error('token expired');
  if (payload.nbf && payload.nbf > now + 60) throw new Error('token not yet valid');
  if (!payload.sub) throw new Error('no subject');
  return {
    sub: String(payload.sub),
    name: String(payload.name || ''),
    email: String(payload.email || ''),
    picture: String(payload.picture || ''),
  };
}

// ---------------- first-party session JWT (HS256) ----------------
export function signSession(user, secret = getSessionSecret(), days = SESSION_DAYS) {
  const h = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64urlEncode(JSON.stringify({
    sub: user.sub, name: user.name || '', email: user.email || '', picture: user.picture || '',
    iat: now, exp: now + days * 86400,
  }));
  const sig = b64urlEncode(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

export function verifySession(token, secret = getSessionSecret()) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header;
  try { header = JSON.parse(b64urlDecode(h).toString('utf8')); } catch { return null; }
  if (header.alg !== 'HS256') return null;
  const expect = b64urlEncode(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  try {
    if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expect))) return null;
  } catch { return null; }
  let payload;
  try { payload = JSON.parse(b64urlDecode(p).toString('utf8')); } catch { return null; }
  if (!payload.sub || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return { sub: String(payload.sub), name: String(payload.name || ''), email: String(payload.email || ''), picture: String(payload.picture || '') };
}

// ---------------- cookies (no cookie-parser dep) ----------------
export function parseCookies(req) {
  const out = {};
  try {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  } catch { /* noop */ }
  return out;
}

const COOKIE_NAME = 'sw_session';
export function sessionCookie(token, secure) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
function sessionUser(req) {
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}
function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

// ---------------- routes ----------------
export function mountAuth(app) {
  // public client ID (Google design: the ID is public, enforcement is origin-based)
  app.get('/api/auth/config', (req, res) => {
    res.json({ clientId: getGoogleClientId() });
  });

  app.post('/api/auth/google', async (req, res) => {
    try {
      const user = await verifyGoogleIdToken(req.body?.credential);
      const token = signSession(user);
      res.setHeader('Set-Cookie', sessionCookie(token, isSecure(req)));
      res.json({ user });
    } catch (e) {
      const status = e.message === 'Google sign-in not configured' ? 501 : 401;
      res.status(status).json({ error: status === 501 ? e.message : 'Invalid Google credential' });
    }
  });

  // always 200 (never 401): every guest hits this on boot, so an error status
  // would spam consoles + diagnostics with a non-error
  app.get('/api/auth/me', (req, res) => {
    res.json({ user: sessionUser(req) });
  });

  app.post('/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ ok: true });
  });
}
