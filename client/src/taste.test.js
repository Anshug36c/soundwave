import { describe, it, expect } from 'vitest';
import {
  MAX_SUGGESTIONS, PLAY_WEIGHT, SKIP_PENALTY, LIKED_BONUS, RECENCY_BONUS, TIME_OF_DAY_BONUS,
  currentTimeOfDay, scoreStats, applyCandidateFilter, trackKeyOf, excludeKey, tasteSeeds,
  scoreQuickPick, scoreLocalMix, equalPowerGains, AdaptivePreArm, mulberry32, hashId,
  newSeed, dailySeed, seededOrder, forgottenFavorites, recentStats,
} from './services/taste';

// Ported from Echo Music v1.4.3:
//   app/src/test/.../generate/LocalTasteScoringTest.kt
//   playback/src/test/.../crossfade/EqualPowerCurveTest.kt
//   playback/src/test/.../crossfade/AdaptivePreArmManagerTest.kt
//   core/src/test/.../db/RecommendationRelationsTest.kt (seeded-ordering rule)

const NOW = 1_800_000_000_000;
const stats = (over = {}) => ({
  trackKey: 'song|artist', title: 'Song', artist: 'Artist',
  totalPlayTimeMs: 1000, playCount: 1, skipCount: 0, lastPlayedAtMillis: NOW,
  ...over,
});

describe('taste weights', () => {
  it('matches the upstream constants', () => {
    expect(MAX_SUGGESTIONS).toBe(25);
    expect(PLAY_WEIGHT).toBe(2.0);
    expect(SKIP_PENALTY).toBe(3.0);
    expect(LIKED_BONUS).toBe(5.0);
    expect(RECENCY_BONUS).toBe(1.5);
    expect(TIME_OF_DAY_BONUS).toBe(1.3);
    // The skip penalty is the heaviest single term upstream.
    expect(SKIP_PENALTY).toBeGreaterThan(PLAY_WEIGHT);
  });
});

describe('trackKeyOf', () => {
  it('cleans whitespace and lowercases', () => {
    expect(trackKeyOf('  Starboy ', ' The Weeknd ')).toBe('starboy|the weeknd');
    expect(trackKeyOf('starboy', 'the weeknd')).toBe(trackKeyOf('STARBOY', 'THE WEEKND'));
  });
});

describe('scoreStats', () => {
  it('every weight and bonus contributes', () => {
    const expectedBase = Math.log(1 + 1000 / 60_000) * PLAY_WEIGHT + RECENCY_BONUS;
    expect(scoreStats(stats(), new Set(), 'afternoon', NOW)).toBeCloseTo(expectedBase, 2);
    expect(scoreStats(stats(), new Set(['song|artist']), 'afternoon', NOW))
      .toBeCloseTo(expectedBase + LIKED_BONUS, 2);
    // 2 skips × 3.0 drives the score negative, and it is floored at 0.
    expect(scoreStats(stats({ skipCount: 2 }), new Set(), 'afternoon', NOW)).toBe(0);
  });

  it('play time is log-normalised, so loops cannot dominate', () => {
    const oneMinute = scoreStats(stats({ totalPlayTimeMs: 60_000 }), new Set(), 'afternoon', NOW);
    const tenMinutes = scoreStats(stats({ totalPlayTimeMs: 600_000 }), new Set(), 'afternoon', NOW);
    expect(tenMinutes).toBeGreaterThan(oneMinute);
    expect(tenMinutes - oneMinute).toBeLessThan(PLAY_WEIGHT * 3);
  });

  it('time-of-day bonuses apply correctly', () => {
    const recent = stats({ totalPlayTimeMs: 100 });
    const morning = scoreStats(recent, new Set(), 'morning', NOW);
    const neutral = scoreStats(recent, new Set(), 'afternoon', NOW);
    expect(morning).toBeCloseTo(neutral * 1.3, 2);

    // Stale + liked: the night bonus rewards likes, not recency.
    const likedOld = stats({ totalPlayTimeMs: 100, lastPlayedAtMillis: 0 });
    const nightLiked = scoreStats(likedOld, new Set(['song|artist']), 'night', NOW);
    const afternoonLiked = scoreStats(likedOld, new Set(['song|artist']), 'afternoon', NOW);
    expect(nightLiked).toBeCloseTo(afternoonLiked * 1.3, 2);
  });

  it('recency uses a 7-day window', () => {
    const fresh = scoreStats(stats({ lastPlayedAtMillis: NOW - 6 * 86_400_000 }), new Set(), 'afternoon', NOW);
    const stale = scoreStats(stats({ lastPlayedAtMillis: NOW - 8 * 86_400_000 }), new Set(), 'afternoon', NOW);
    expect(fresh - stale).toBeCloseTo(RECENCY_BONUS, 2);
  });

  it('time-of-day buckets match the specification', () => {
    expect(currentTimeOfDay(6)).toBe('morning');
    expect(currentTimeOfDay(11)).toBe('morning');
    expect(currentTimeOfDay(12)).toBe('afternoon');
    expect(currentTimeOfDay(17)).toBe('afternoon');
    expect(currentTimeOfDay(18)).toBe('evening');
    expect(currentTimeOfDay(21)).toBe('evening');
    expect(currentTimeOfDay(22)).toBe('night');
    expect(currentTimeOfDay(3)).toBe('night');
  });
});

describe('applyCandidateFilter', () => {
  it('follows the upstream truth table', () => {
    expect(applyCandidateFilter(stats({ skipCount: 0, totalPlayTimeMs: 10_000 }))).toBe(true);
    expect(applyCandidateFilter(stats({ skipCount: 1, totalPlayTimeMs: 10_000 }))).toBe(true);
    expect(applyCandidateFilter(stats({ skipCount: 2, totalPlayTimeMs: 10_000 }))).toBe(false);
    expect(applyCandidateFilter(stats({ skipCount: 2, totalPlayTimeMs: 50_000 }))).toBe(true);
    expect(applyCandidateFilter(stats({ skipCount: 5, totalPlayTimeMs: 60_000 }))).toBe(true);
  });
});

describe('excludeKey', () => {
  it('folds accents and punctuation exactly like the server does', () => {
    // Wire contract, pinned on both sides: server/test/metadata.test.js asserts
    // these same literals for its own excludeKey. Change one, change both.
    expect(excludeKey('Nimbooda Nimbooda', 'A. R. Rahman')).toBe('nimboodanimbooda|arrahman');
    expect(excludeKey('Ça Va', 'Kafkaya')).toBe(excludeKey('ca va', 'kafkaya'));
    expect(excludeKey(' Faded ', 'Alan Walker')).toBe('faded|alanwalker');
    expect(excludeKey('Faded', 'Alan Walker')).not.toBe(excludeKey('Faded', 'Someone Else'));
  });
});

describe('tasteSeeds', () => {
  it('ranks by score, drops exclusions and hard skips, caps the count', () => {
    const pool = [
      stats({ trackKey: 'a|x', totalPlayTimeMs: 600_000 }),
      stats({ trackKey: 'b|x', totalPlayTimeMs: 60_000, skipCount: 4 }),
      stats({ trackKey: 'c|x', totalPlayTimeMs: 30_000 }),
      stats({ trackKey: 'd|x', totalPlayTimeMs: 90_000 }),
    ];
    const picked = tasteSeeds(pool, { likedKeys: new Set(['c|x']), count: 3, now: NOW, timeOfDay: 'afternoon' });
    expect(picked.map((p) => p.stats.trackKey)).not.toContain('b|x');
    expect(picked).toHaveLength(3);
    expect(picked[0].score).toBeGreaterThanOrEqual(picked[1].score);
    // A like outranks 10× the listening time of an unliked recent track.
    expect(picked.map((p) => p.stats.trackKey).indexOf('c|x'))
      .toBeLessThan(picked.map((p) => p.stats.trackKey).indexOf('d|x'));
  });

  it('returns nothing when every candidate is excluded', () => {
    const pool = [stats({ trackKey: 'a|x' })];
    expect(tasteSeeds(pool, { excluded: new Set(['a|x']), now: NOW })).toEqual([]);
  });
});

describe('quick picks and local mix scoring', () => {
  it('likes beat listening time in quick picks', () => {
    const liked = scoreQuickPick({ id: 'a', totalPlayTimeMs: 0 }, new Set(['a']));
    const played = scoreQuickPick({ id: 'b', totalPlayTimeMs: 15 * 60_000 }, new Set());
    expect(liked).toBe(50);
    expect(played).toBe(30);
    expect(scoreQuickPick({ id: 'c', totalPlayTimeMs: 5_000_000 }, new Set())).toBe(120); // capped at 60 min
  });

  it('a shared artist dominates the local mix score', () => {
    const seed = { id: 's', artist: { name: 'Diljit Dosanjh' } };
    const same = { id: 'a', artist: { name: 'diljit dosanjh' }, totalPlayTimeMs: 0 };
    const other = { id: 'b', artist: { name: 'Someone Else' }, totalPlayTimeMs: 60 * 60_000 };
    expect(scoreLocalMix(same, seed, new Set())).toBe(100);
    expect(scoreLocalMix(other, seed, new Set(['b']))).toBe(30 + 60);
  });
});

describe('equalPowerGains', () => {
  it('hits the boundary values', () => {
    expect(equalPowerGains(0).outgoingGain).toBeCloseTo(1, 3);
    expect(equalPowerGains(0).incomingGain).toBeCloseTo(0, 3);
    expect(equalPowerGains(1).outgoingGain).toBeCloseTo(0, 3);
    expect(equalPowerGains(1).incomingGain).toBeCloseTo(1, 3);
  });

  it('keeps total acoustic power at 1.0 across the whole fade', () => {
    for (let i = 0; i <= 100; i++) {
      const { outgoingGain: o, incomingGain: n } = equalPowerGains(i / 100);
      expect(Math.abs(o * o + n * n - 1)).toBeLessThan(0.005);
    }
  });

  it('meets at √2/2 in the middle', () => {
    const { outgoingGain, incomingGain } = equalPowerGains(0.5);
    expect(outgoingGain).toBeCloseTo(incomingGain, 3);
    expect(outgoingGain).toBeCloseTo(0.7071, 3);
  });

  it('clamps junk input instead of producing NaN', () => {
    expect(equalPowerGains(NaN).outgoingGain).toBe(1);
    expect(equalPowerGains(-5).outgoingGain).toBe(1);
    expect(equalPowerGains(99).incomingGain).toBe(1);
  });
});

describe('AdaptivePreArm', () => {
  it('starts at the base lead time', () => {
    expect(new AdaptivePreArm(20_000, 35_000).currentLeadTimeMs).toBe(20_000);
  });

  it('expands when preparation is slow', () => {
    const m = new AdaptivePreArm(20_000, 35_000);
    m.recordPreparationDuration(9_000);
    expect(m.currentLeadTimeMs).toBeGreaterThan(20_000);
    m.recordPreparationDuration(12_000);
    expect(m.currentLeadTimeMs).toBeGreaterThanOrEqual(25_000);
  });

  it('caps at the maximum lead time', () => {
    const m = new AdaptivePreArm(20_000, 35_000);
    m.recordPreparationDuration(30_000);
    m.recordPreparationDuration(30_000);
    expect(m.currentLeadTimeMs).toBe(35_000);
  });

  it('contracts gradually when preparation is fast', () => {
    const m = new AdaptivePreArm(20_000, 35_000);
    m.recordPreparationDuration(10_000);
    const expanded = m.currentLeadTimeMs;
    m.recordPreparationDuration(1_000);
    m.recordPreparationDuration(1_000);
    m.recordPreparationDuration(1_000);
    expect(m.currentLeadTimeMs).toBeLessThan(expanded);
    expect(m.currentLeadTimeMs).toBeGreaterThanOrEqual(20_000);
  });

  it('resets to base and rejects nonsense construction', () => {
    const m = new AdaptivePreArm(20_000, 35_000);
    m.recordPreparationDuration(30_000);
    m.reset();
    expect(m.currentLeadTimeMs).toBe(20_000);
    expect(() => new AdaptivePreArm(0, 35_000)).toThrow();
    expect(() => new AdaptivePreArm(40_000, 35_000)).toThrow();
    expect(() => new AdaptivePreArm(20_000, 35_000, 0)).toThrow();
  });
});

describe('per-invocation seeded ordering (Echo v1.4.3 rule)', () => {
  const pool = Array.from({ length: 160 }, (_, i) => ({ id: `track_${i}` }));

  it('is stable across repeated reads with one seed', () => {
    const seed = 987_654_321;
    const first = seededOrder(pool, seed).map((t) => t.id);
    for (let i = 0; i < 8; i++) {
      expect(seededOrder(pool, seed).map((t) => t.id)).toEqual(first);
    }
  });

  it('varies when the seed changes', () => {
    expect(seededOrder(pool, 987_654_321).map((t) => t.id))
      .not.toEqual(seededOrder(pool, 1_664_525).map((t) => t.id));
  });

  it('preserves membership and never mutates the input', () => {
    const out = seededOrder(pool, 42);
    expect(out).toHaveLength(pool.length);
    expect(out.map((t) => t.id).sort()).toEqual(pool.map((t) => t.id).sort());
    expect(pool[0].id).toBe('track_0');
  });

  it('newSeed is positive and odd, dailySeed is stable within a day', () => {
    for (let i = 0; i < 50; i++) {
      const s = newSeed();
      expect(s).toBeGreaterThan(0);
      expect(s % 2).toBe(1);
    }
    const d = new Date(2026, 9, 14, 9, 0, 0);
    expect(dailySeed(d)).toBe(dailySeed(new Date(2026, 9, 14, 23, 59, 59)));
    expect(dailySeed(d)).not.toBe(dailySeed(new Date(2026, 9, 15, 0, 0, 1)));
    // Regression: `base | 1` made two consecutive days share a seed, so the
    // daily mix silently stopped refreshing. Every day of a month must differ.
    const days = new Set();
    for (let day = 1; day <= 31; day++) days.add(dailySeed(new Date(2026, 9, day, 12)));
    expect(days.size).toBe(31);
  });

  it('mulberry32 is deterministic and hashId is a positive 31-bit int', () => {
    const a = mulberry32(7), b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(hashId('track_1')).toBe(hashId('track_1'));
    expect(hashId('track_1')).not.toBe(hashId('track_2'));
    expect(hashId('track_1')).toBeGreaterThanOrEqual(0);
    expect(hashId('track_1')).toBeLessThanOrEqual(2147483647);
  });
});

describe('forgottenFavorites', () => {
  const entries = [
    { id: 'quiet-liked', liked: true, totalPlayTimeMs: 10_000, skipCount: 0, lastPlayedAtMillis: NOW - 30 * 86_400_000 },
    { id: 'quiet-played', liked: false, totalPlayTimeMs: 300_000, skipCount: 0, lastPlayedAtMillis: NOW - 20 * 86_400_000 },
    { id: 'still-rotating', liked: true, totalPlayTimeMs: 300_000, skipCount: 0, lastPlayedAtMillis: NOW - 2 * 86_400_000 },
    { id: 'skipped-out', liked: false, totalPlayTimeMs: 5_000, skipCount: 3, lastPlayedAtMillis: NOW - 40 * 86_400_000 },
  ];

  it('surfaces quiet tracks and hides the ones still in rotation', () => {
    const ids = forgottenFavorites(entries, { now: NOW, seed: 5, quietDays: 14 }).map((e) => e.id);
    expect(ids).toContain('quiet-liked');
    expect(ids).toContain('quiet-played');
    expect(ids).not.toContain('still-rotating');
    expect(ids).not.toContain('skipped-out');
  });

  it('is stable within a seed and varies across seeds', () => {
    const big = Array.from({ length: 120 }, (_, i) => ({
      id: `t_${i}`, liked: i % 3 === 0, totalPlayTimeMs: 60_000, skipCount: 0,
      lastPlayedAtMillis: NOW - (20 + i) * 86_400_000,
    }));
    const once = forgottenFavorites(big, { now: NOW, seed: 12345, limit: 12 }).map((e) => e.id);
    expect(forgottenFavorites(big, { now: NOW, seed: 12345, limit: 12 }).map((e) => e.id)).toEqual(once);
    expect(forgottenFavorites(big, { now: NOW, seed: 999, limit: 12 }).map((e) => e.id)).not.toEqual(once);
    expect(once).toHaveLength(12);
  });

  it('handles an empty pool', () => {
    expect(forgottenFavorites([], { now: NOW })).toEqual([]);
    expect(forgottenFavorites(null, { now: NOW })).toEqual([]);
  });
});

describe('recentStats', () => {
  it('keeps the 30-day window, newest first', () => {
    const pool = [
      stats({ trackKey: 'old', lastPlayedAtMillis: NOW - 40 * 86_400_000 }),
      stats({ trackKey: 'mid', lastPlayedAtMillis: NOW - 10 * 86_400_000 }),
      stats({ trackKey: 'new', lastPlayedAtMillis: NOW - 1000 }),
    ];
    expect(recentStats(pool, { now: NOW }).map((s) => s.trackKey)).toEqual(['new', 'mid']);
    expect(recentStats(pool, { now: NOW, limit: 1 })).toHaveLength(1);
  });
});
