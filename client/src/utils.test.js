import { describe, it, expect } from 'vitest';
import { timeAgo, shuffleList, effectiveQuality, streamFor, formatTime } from './services/musicApi';

describe('timeAgo', () => {
  it('formats seconds/minutes/hours/days', () => {
    const now = Date.now();
    expect(timeAgo(now - 5000)).toBe('5s ago');
    expect(timeAgo(now - 3 * 60000)).toBe('3m ago');
    expect(timeAgo(now - 5 * 3600000)).toBe('5h ago');
    expect(timeAgo(now - 26 * 3600000)).toBe('Yesterday');
    expect(timeAgo(now - 4 * 86400000)).toBe('4d ago');
  });
  it('handles missing timestamps', () => {
    expect(timeAgo(null)).toBe('');
    expect(timeAgo(undefined)).toBe('');
  });
});

describe('shuffleList', () => {
  it('preserves membership and does not mutate', () => {
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffleList(src);
    expect(out).toHaveLength(src.length);
    expect([...out].sort()).toEqual([...src].sort());
    expect(src).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(out).not.toBe(src);
  });
  it('handles empty input', () => {
    expect(shuffleList([])).toEqual([]);
    expect(shuffleList(null)).toEqual([]);
  });
});

describe('effectiveQuality', () => {
  it('passes explicit tiers through', () => {
    expect(effectiveQuality('low')).toBe('low');
    expect(effectiveQuality('medium')).toBe('medium');
    expect(effectiveQuality('high')).toBe('high');
  });
  it('defaults auto to high without network info', () => {
    expect(effectiveQuality('auto')).toBe('high');
    expect(effectiveQuality(undefined)).toBe('high');
  });
});

describe('streamFor', () => {
  const t = (u) => ({ streamUrl: u });
  it('returns empty string without a streamUrl', () => {
    expect(streamFor({})).toBe('');
    expect(streamFor(null)).toBe('');
  });
  it('appends the resolved quality param', () => {
    const url = 'https://srv.example/api/audio?m=djp:123';
    expect(streamFor(t(url), 'low')).toBe(`${url}&quality=low&t=&ar=`);
    expect(streamFor(t(url), 'auto')).toContain('quality=high');
  });
  it('uses ? when no query string exists', () => {
    expect(streamFor(t('https://cdn.example/x.mp3'), 'low')).toBe('https://cdn.example/x.mp3?quality=low&t=&ar=');
  });
});

describe('formatTime', () => {
  it('formats m:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(3661)).toBe('61:01');
  });
  it('handles NaN/negative', () => {
    expect(formatTime(NaN)).toBe('0:00');
    expect(formatTime(-5)).toBe('0:00');
  });
});
