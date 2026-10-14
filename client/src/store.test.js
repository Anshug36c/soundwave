import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store/useStore';
import { trackKeyOf, excludeKey } from './services/taste';

// The taste maths itself is covered in taste.test.js. These tests cover the
// wiring: does the store actually accumulate what the engine reports, and does
// the exclusion list that crosses the wire contain what the server expects?

const track = (id, title = 'Song', artist = 'Artist') => ({
  id, title, artist: { id: '', name: artist, image: '' }, duration: 200, streamUrl: `/api/audio?src=djp&id=${id}`,
});

const reset = () => useStore.setState({
  queue: [], index: -1, currentTime: 0, history: [], playCounts: {}, playStats: {},
  liked: {}, disliked: {}, hiddenArtists: {}, tasteMix: { day: 0, seed: 0 }, toasts: [],
});

describe('playStats', () => {
  beforeEach(reset);

  it('opens a stats entry when a track starts playing', () => {
    useStore.getState().pushHistory(track('djp:1', 'Faded', 'Alan Walker'));
    const st = useStore.getState().playStats['djp:1'];
    expect(st.playCount).toBe(1);
    expect(st.totalPlayTimeMs).toBe(0);
    expect(st.skipCount).toBe(0);
    expect(st.trackKey).toBe(trackKeyOf('Faded', 'Alan Walker'));
    expect(st.lastPlayedAtMillis).toBeGreaterThan(0);
  });

  it('accumulates listening time in small deltas', () => {
    const t = track('djp:2', 'Song', 'Artist');
    useStore.getState().pushHistory(t);
    useStore.getState().recordPlayTime(t, 5000);
    useStore.getState().recordPlayTime(t, 4000);
    expect(useStore.getState().playStats['djp:2'].totalPlayTimeMs).toBe(9000);
    expect(useStore.getState().playStats['djp:2'].playCount).toBe(1); // time is not a play
  });

  it('ignores junk deltas: negative, zero, absurd (a throttled tab waking up)', () => {
    const t = track('djp:3');
    useStore.getState().pushHistory(t);
    useStore.getState().recordPlayTime(t, -500);
    useStore.getState().recordPlayTime(t, 0);
    useStore.getState().recordPlayTime(t, 600000); // clamped to 10s, not 10min
    useStore.getState().recordPlayTime(null, 1000);
    expect(useStore.getState().playStats['djp:3'].totalPlayTimeMs).toBe(10000);
  });

  it('counts skips separately from plays', () => {
    const t = track('djp:4');
    useStore.getState().pushHistory(t);
    useStore.getState().recordSkip(t);
    useStore.getState().recordSkip(t);
    const st = useStore.getState().playStats['djp:4'];
    expect(st.skipCount).toBe(2);
    expect(st.totalPlayTimeMs).toBe(0);
  });

  it('only counts a skip when the listener bailed early', () => {
    const s = useStore.getState();
    s.playTracks([track('djp:5'), track('djp:6')]);
    useStore.setState({ currentTime: 8 });
    useStore.getState().next();            // 8s in → a skip
    expect(useStore.getState().playStats['djp:5'].skipCount).toBe(1);

    useStore.setState({ currentTime: 120 });
    useStore.getState().prev();            // well past 30s → not a skip
    const after = useStore.getState().playStats['djp:6'];
    expect(after?.skipCount || 0).toBe(0);

    useStore.setState({ currentTime: 0 });
    useStore.getState().next();            // never started → not a skip either
    expect(useStore.getState().playStats['djp:6']?.skipCount || 0).toBe(0);
  });

  it('caps the stats table so localStorage cannot grow forever', () => {
    for (let i = 0; i < 450; i++) useStore.getState().pushHistory(track(`id:${i}`, `T${i}`, 'A'));
    const keys = Object.keys(useStore.getState().playStats);
    expect(keys.length).toBeLessThanOrEqual(400);
    // The oldest entries are the ones dropped, and the newest survives.
    expect(keys).toContain('id:449');
    expect(keys).not.toContain('id:0');
  });
});

describe('never recommend again', () => {
  beforeEach(reset);

  it('excludes by id and by the server-side title|artist key', () => {
    const t = track('djp:9', 'Faded', 'Alan Walker');
    useStore.getState().pushHistory(t);
    useStore.getState().neverRecommend(t);
    const keys = useStore.getState().excludeKeys();
    expect(keys).toContain('djp:9');
    expect(keys).toContain(excludeKey('Faded', 'Alan Walker'));
    expect(useStore.getState().disliked['djp:9']).toBe(true);
  });

  it('is reversible, and the reversal removes both keys', () => {
    const t = track('djp:10', 'Song', 'Artist');
    useStore.getState().pushHistory(t);
    useStore.getState().neverRecommend(t);
    useStore.getState().neverRecommend(t);
    expect(useStore.getState().disliked['djp:10']).toBeUndefined();
    expect(useStore.getState().excludeKeys()).toEqual([]);
  });

  it('still excludes a track whose object was never stored (id-only dislike)', () => {
    useStore.setState({ disliked: { 'ytv:abc': true } });
    expect(useStore.getState().excludeKeys()).toEqual(['ytv:abc']);
  });

  it('resets with the rest of the taste profile', () => {
    const t = track('djp:11');
    useStore.getState().pushHistory(t);
    useStore.getState().neverRecommend(t);
    useStore.getState().resetTaste();
    expect(useStore.getState().playStats).toEqual({});
    expect(useStore.getState().excludeKeys()).toEqual([]);
  });
});

describe('Daily Taste Mix', () => {
  beforeEach(reset);

  it('seeds once per day and keeps that seed across mounts', () => {
    const first = useStore.getState().syncTasteMix();
    expect(first).toBeGreaterThan(0);
    expect(useStore.getState().syncTasteMix()).toBe(first); // no duplicate mix per visit
    expect(useStore.getState().tasteMix.day).toBe(first);
  });

  it('a manual refresh rolls a new per-invocation seed but keeps the day', () => {
    const day = useStore.getState().syncTasteMix();
    const rolled = useStore.getState().refreshTasteMix();
    expect(rolled).not.toBe(day);
    expect(useStore.getState().tasteMix.day).toBe(day);
    expect(useStore.getState().tasteMix.seed).toBe(rolled);
  });
});

describe('varispeed', () => {
  beforeEach(reset);

  it('defaults off so speed changes stay pitch-preserving', () => {
    expect(useStore.getState().varispeed).toBe(false);
    useStore.getState().setVarispeed(true);
    expect(useStore.getState().varispeed).toBe(true);
    useStore.getState().setVarispeed(0); // coerced, the store never holds junk
    expect(useStore.getState().varispeed).toBe(false);
  });
});

describe('skip accounting edges', () => {
  beforeEach(reset);

  it('counts one skip, not two, when a playing track is replaced via a context', () => {
    // playTrack(track, context) delegates to playTracks; both must not bill the
    // outgoing track twice for the same bail-out.
    const a = track('djp:20'), b = track('djp:21');
    useStore.getState().playTracks([a, b]);
    useStore.setState({ currentTime: 10 });
    useStore.getState().playTrack(b, [a, b]);
    expect(useStore.getState().playStats['djp:20'].skipCount).toBe(1);
  });

  it('counts one skip when a playing track is replaced without a context', () => {
    const a = track('djp:22');
    useStore.getState().playTracks([a]);
    useStore.setState({ currentTime: 12 });
    useStore.getState().playTrack(track('djp:23'));
    expect(useStore.getState().playStats['djp:22'].skipCount).toBe(1);
  });
});
