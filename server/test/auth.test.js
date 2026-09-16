// node --test test/auth.test.js (no deps)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyGoogleIdToken, signSession, verifySession,
  parseCookies, sessionCookie, clearSessionCookie,
} from '../auth.js';

const CID = 'test-client-id.apps.googleusercontent.com';
const SECRET = 'test-secret-123';

function b64url(o) {
  return Buffer.from(typeof o === 'string' ? o : JSON.stringify(o))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// fake Google: real RSA keypair, only the test trusts it
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const KID = 'test-kid-1';
const certs = { [KID]: { ...jwk, kid: KID, alg: 'RS256', use: 'sig' } };
const getCerts = async () => certs;

function googleToken(payload, kid = KID, key = privateKey) {
  const h = b64url({ alg: 'RS256', kid, typ: 'JWT' });
  const p = b64url(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${h}.${p}.${sig}`;
}

const now = () => Math.floor(Date.now() / 1000);
const goodPayload = () => ({
  iss: 'https://accounts.google.com', aud: CID, sub: '12345',
  name: 'Test User', email: 'test@gmail.com', picture: 'https://x/y.jpg',
  iat: now(), exp: now() + 3600,
});

describe('verifyGoogleIdToken', () => {
  it('accepts a well-formed token', async () => {
    const u = await verifyGoogleIdToken(googleToken(goodPayload()), { clientId: CID, getCerts });
    assert.equal(u.sub, '12345');
    assert.equal(u.email, 'test@gmail.com');
  });
  it('rejects wrong audience', async () => {
    await assert.rejects(() => verifyGoogleIdToken(
      googleToken({ ...goodPayload(), aud: 'evil.apps.googleusercontent.com' }), { clientId: CID, getCerts }));
  });
  it('rejects expired tokens', async () => {
    await assert.rejects(() => verifyGoogleIdToken(
      googleToken({ ...goodPayload(), exp: now() - 10 }), { clientId: CID, getCerts }));
  });
  it('rejects bad issuer', async () => {
    await assert.rejects(() => verifyGoogleIdToken(
      googleToken({ ...goodPayload(), iss: 'https://evil.com' }), { clientId: CID, getCerts }));
  });
  it('rejects tampered payload', async () => {
    const t = googleToken(goodPayload()).split('.');
    t[1] = b64url({ ...goodPayload(), email: 'admin@gmail.com' });
    await assert.rejects(() => verifyGoogleIdToken(t.join('.'), { clientId: CID, getCerts }));
  });
  it('rejects unknown kid', async () => {
    await assert.rejects(() => verifyGoogleIdToken(googleToken(goodPayload(), 'nope'), { clientId: CID, getCerts }));
  });
  it('rejects tokens signed by another key', async () => {
    const evil = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await assert.rejects(() => verifyGoogleIdToken(googleToken(goodPayload(), KID, evil), { clientId: CID, getCerts }));
  });
  it('rejects malformed input', async () => {
    for (const bad of [null, '', 'a.b', 'a.b.c.d', 'notajwt']) {
      await assert.rejects(() => verifyGoogleIdToken(bad, { clientId: CID, getCerts }));
    }
  });
});

describe('session JWT', () => {
  const user = { sub: '12345', name: 'T', email: 't@gmail.com', picture: '' };
  it('round-trips', () => {
    assert.equal(verifySession(signSession(user, SECRET), SECRET).sub, '12345');
  });
  it('rejects tampered payload', () => {
    const [h, p, s] = signSession(user, SECRET).split('.');
    const evil = b64url({ sub: '999', exp: now() + 9999 });
    assert.equal(verifySession(`${h}.${evil}.${s}`, SECRET), null);
  });
  it('rejects wrong secret', () => {
    assert.equal(verifySession(signSession(user, SECRET), 'other'), null);
  });
  it('rejects expired sessions', () => {
    assert.equal(verifySession(signSession(user, SECRET, -1), SECRET), null);
  });
  it('rejects malformed tokens', () => {
    for (const bad of [null, '', 'a.b', 'a.b.c.d']) assert.equal(verifySession(bad, SECRET), null);
  });
});

describe('cookies', () => {
  it('parses cookie headers', () => {
    assert.deepEqual(parseCookies({ headers: { cookie: 'a=1; sw_session=abc.def.ghi; b=2' } }).sw_session, 'abc.def.ghi');
    assert.deepEqual(parseCookies({ headers: {} }), {});
  });
  it('sets HttpOnly Lax cookies, Secure only on https', () => {
    const c = sessionCookie('tok', true);
    assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Lax/); assert.match(c, /Secure/);
    assert.doesNotMatch(sessionCookie('tok', false), /Secure/);
  });
  it('clears with Max-Age=0', () => {
    assert.match(clearSessionCookie(), /Max-Age=0/);
  });
});
