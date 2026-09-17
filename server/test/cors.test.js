// node --test test/cors.test.js (no deps)
//
// Boots the real server (FRONTEND_URL allowlist via env) and asserts the CORS layer
// actually emits headers. Guards the split deployment — static client on one host,
// API on another — where every /api fetch and the WebAudio graph depend on these.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PORT = 5199;
const ALLOWED = 'https://soundwave.test';
const BLOCKED = 'https://evil.test';

process.env.PORT = String(PORT);
process.env.FRONTEND_URL = `${ALLOWED},https://other.test`;

// dynamic import so env above is read before the module evaluates its allowlist
const server = (await import('../server.js')).default;
const BASE = `http://127.0.0.1:${PORT}`;

// poll until listening (server.js boots providers asynchronously)
before(async () => {
  for (let i = 0; i < 200; i++) {
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(500) });
      return;
    } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server never became ready');
});

after(() => { try { server?.close(); } catch { /* noop */ } });

describe('CORS', () => {
  it('echoes an allowlisted origin and exposes the audio headers', async () => {
    const r = await fetch(`${BASE}/api/health`, { headers: { Origin: ALLOWED } });
    assert.equal(r.headers.get('access-control-allow-origin'), ALLOWED);
    // combined header: our 'Origin' plus 'Accept-Encoding' appended by the
    // compression middleware. Both must survive — dropping either mis-caches.
    assert.match(r.headers.get('vary') || '', /Origin/);
    assert.match(r.headers.get('vary') || '', /Accept-Encoding/);
    assert.match(r.headers.get('access-control-expose-headers') || '', /X-Audio-Cache/);
  });

  it('answers a preflight without routing it to the API', async () => {
    const r = await fetch(`${BASE}/api/auth/google`, {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), ALLOWED);
    assert.match(r.headers.get('access-control-allow-headers') || '', /Content-Type/);
    assert.match(r.headers.get('access-control-allow-methods') || '', /POST/);
  });

  it('omits CORS headers for an origin that is not allowlisted', async () => {
    const r = await fetch(`${BASE}/api/health`, { headers: { Origin: BLOCKED } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.equal(r.status, 200); // still serves the public data; the browser is what blocks it
  });

  it('is a no-op for same-origin requests (no Origin header)', async () => {
    const r = await fetch(`${BASE}/api/health`);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.equal(r.status, 200);
  });

  it('never allows credentials — sessions are SameSite=Lax and cookie-only', async () => {
    const r = await fetch(`${BASE}/api/health`, { headers: { Origin: ALLOWED } });
    assert.equal(r.headers.get('access-control-allow-credentials'), null);
    assert.notEqual(r.headers.get('access-control-allow-origin'), '*'); // would be invalid with credentials
  });
});
