// node --test test/des.test.js (no deps)
//
// Pins the pure-JS DES against vectors produced by Node's own
// crypto.createCipheriv('des-ecb', ...) under --openssl-legacy-provider — i.e.
// against the implementation it replaced. If the tables or the key schedule are
// ever wrong, these fail; JioSaavn playback would otherwise break silently,
// because saavnDecrypt swallows errors and returns ''.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { desDecryptBase64 } from '../des.js';

const KEY = Buffer.from('38346591', 'utf8');

// [plaintext, base64 ciphertext] — generated with Node's legacy-provider DES.
const VECTORS = [
  ['', 'GBTsxqxbyf8='],                       // empty input: one full padding block
  ['a', 'sjSYyK2oY34='],                      // short
  ['12345678', '81SBY3r0THcYFOzGrFvJ/w=='],   // exactly one block -> adds a whole padding block
  ['123456789', '81SBY3r0THdG8Dqa4kEPog=='],  // spills into a second block
  ['https://aa.cf.saavncdn.com/123/abc-320.mp4?key=xyz',
    'ID2ieOjCrwfGLX41fL1Bv9Fhi50sf21co0v8swvifC2bVoTE0OOQv0WCqr5L2+H2vi+4iiT5gEg='],
  ['पंजाबी', 'h1Fk29okeI/UUH5wVgGDrvxCAlAtu3Lf'], // multi-byte UTF-8
];

describe('DES-ECB (pure JS)', () => {
  for (const [plain, cipher] of VECTORS) {
    it(`decrypts ${JSON.stringify(plain).slice(0, 40)}`, () => {
      assert.equal(desDecryptBase64(cipher, KEY).toString('utf8'), plain);
    });
  }

  it('rejects ciphertext that is not a multiple of 8 bytes', () => {
    const bad = Buffer.from('0123456789ab', 'hex').toString('base64'); // 6 bytes
    assert.throws(() => desDecryptBase64(bad, KEY), /multiple of 8 bytes/);
  });

  it('rejects an empty ciphertext', () => {
    assert.throws(() => desDecryptBase64('', KEY), /multiple of 8 bytes/);
  });

  it('rejects a wrong-length key', () => {
    assert.throws(() => desDecryptBase64('GBTsxqxbyf8=', Buffer.from('short')), /8 bytes/);
  });

  it('detects corrupted ciphertext via padding validation', () => {
    // flip one byte of a valid ciphertext; padding check must catch it
    const raw = Buffer.from('sjSYyK2oY34=', 'base64');
    raw[0] ^= 0xff;
    assert.throws(() => desDecryptBase64(raw.toString('base64'), KEY), /padding/);
  });
});
