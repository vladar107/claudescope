import { describe, expect, it } from 'vitest';
import { cv, iqr, mannWhitneyGreater, median, percentile } from '../perf/stats.js';

describe('median / percentile / iqr / cv', () => {
  it('computes median for odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('computes percentiles on the sorted samples', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(100);
  });

  it('iqr is the 75th minus the 25th percentile', () => {
    expect(iqr([1, 2, 3, 4])).toBe(3 - 1);
  });

  it('cv is stddev over mean, 0 for constant or tiny samples', () => {
    expect(cv([5])).toBe(0);
    expect(cv([5, 5, 5, 5])).toBe(0);
    // mean 10, sample stddev 2 → CV 0.2
    expect(cv([8, 10, 12, 10])).toBeCloseTo(Math.sqrt(8 / 3) / 10, 5);
  });
});

describe('mannWhitneyGreater', () => {
  it('detects a clearly shifted candidate (p < 0.01 with 10v10 separated samples)', () => {
    const base = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
    const cand = [130, 131, 132, 133, 134, 135, 136, 137, 138, 139];
    expect(mannWhitneyGreater(base, cand)).toBeLessThan(0.01);
  });

  it('reports no evidence when the candidate is faster', () => {
    const base = [130, 131, 132, 133, 134];
    const cand = [100, 101, 102, 103, 104];
    expect(mannWhitneyGreater(base, cand)).toBeGreaterThan(0.9);
  });

  it('returns 1 for fully tied or empty samples', () => {
    expect(mannWhitneyGreater([5, 5, 5], [5, 5, 5])).toBe(1);
    expect(mannWhitneyGreater([], [1, 2, 3])).toBe(1);
  });

  it('overlapping same-distribution samples are not significant', () => {
    const base = [10, 12, 11, 13, 12, 11, 10, 13, 12, 11];
    const cand = [11, 12, 10, 13, 11, 12, 13, 10, 12, 11];
    expect(mannWhitneyGreater(base, cand)).toBeGreaterThan(0.1);
  });
});
