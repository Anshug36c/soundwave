import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, toTrack, ytVideoInfo } from '../youtube.js';

// Pure helpers only. The network paths (search, info) are verified against the
// live API by hand: a test that depends on YouTube answering would fail CI on
// every outage and teach everyone to ignore red.

test('parseDuration handles mm:ss, h:mm:ss and non-durations', () => {
  assert.equal(parseDuration('4:28'), 268);
  assert.equal(parseDuration('1:02:11'), 3731);
  assert.equal(parseDuration('0:59'), 59);
  assert.equal(parseDuration('LIVE'), 0, 'live streams have no length');
  assert.equal(parseDuration(''), 0);
  assert.equal(parseDuration(null), 0);
  assert.equal(parseDuration(undefined), 0);
});

test('toTrack produces the shape the rest of the app expects', () => {
  const t = toTrack({ id: 'abc123XYZ', title: 'Some Video', channel: 'Some Channel', duration: 200, views: 42 });
  // The queue, likes, history and the Android notification all key off these.
  assert.equal(t.id, 'ytv:abc123XYZ');
  assert.equal(t.source, 'ytv');
  assert.equal(t.sourceId, 'abc123XYZ');
  assert.equal(t.ytId, 'abc123XYZ');
  assert.equal(t.type, 'video');
  assert.equal(t.kind, 'video');
  assert.equal(t.title, 'Some Video');
  assert.equal(t.artist.name, 'Some Channel');
  assert.equal(t.album.name, 'YouTube');
  assert.equal(t.duration, 200);
  assert.equal(t.plays, 42);
  assert.equal(t.image, 'https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg');
  // The engine keys off an empty streamUrl to know this track belongs to the
  // embedded player rather than the <audio> element. A non-empty value here
  // would route it down the normal streaming path and fail.
  assert.equal(t.streamUrl, '');
  assert.equal(t.previewUrl, '');
});

test('toTrack falls back sensibly on partial data', () => {
  const t = toTrack({ id: 'x1' });
  assert.equal(t.title, 'Unknown');
  assert.equal(t.artist.name, 'YouTube');
  assert.equal(t.duration, 0);
  assert.equal(t.image, 'https://i.ytimg.com/vi/x1/hqdefault.jpg');
});

test('ytVideoInfo rejects ids that cannot be YouTube ids without a request', async () => {
  // Guards against a caller turning arbitrary user input into an outbound fetch.
  assert.equal(await ytVideoInfo(''), null);
  assert.equal(await ytVideoInfo('has spaces and !!'), null);
  assert.equal(await ytVideoInfo('a'.repeat(40)), null);
  assert.equal(await ytVideoInfo('../../../etc/passwd'), null);
});
