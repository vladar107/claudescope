import { describe, expect, it } from 'vitest';
import { computeStreaks } from '../src/routes/analytics-activity.js';

describe('computeStreaks', () => {
  it('counts a run ending today', () => {
    const s = computeStreaks(['2026-06-27', '2026-06-28', '2026-06-29'], '2026-06-29');
    expect(s).toEqual({ current: 3, longest: 3, lastActiveDay: '2026-06-29' });
  });
  it('keeps current alive when the last active day is yesterday', () => {
    const s = computeStreaks(['2026-06-27', '2026-06-28'], '2026-06-29');
    expect(s.current).toBe(2);
  });
  it('breaks current when the gap to today is >1 day', () => {
    const s = computeStreaks(['2026-06-20', '2026-06-21'], '2026-06-29');
    expect(s.current).toBe(0);
    expect(s.longest).toBe(2);
  });
  it('finds the longest run across gaps', () => {
    const s = computeStreaks(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-10'], '2026-06-29');
    expect(s.longest).toBe(3);
    expect(s.current).toBe(0);
  });
  it('handles a single day and unsorted/duplicate input', () => {
    expect(computeStreaks(['2026-06-29', '2026-06-29'], '2026-06-29')).toEqual({ current: 1, longest: 1, lastActiveDay: '2026-06-29' });
  });
  it('handles no activity', () => {
    expect(computeStreaks([], '2026-06-29')).toEqual({ current: 0, longest: 0, lastActiveDay: null });
  });
});
