import { describe, expect, it } from 'vitest';
import { clampCut, clampLabel } from '../src/components/limits.js';
import { CHUNK_TURNS, mountCountFor } from '../src/pages/session/useProgressiveMount.js';

describe('clampCut', () => {
  it('cuts at the last line boundary before the limit', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd';
    // limit 12 → last \n at or before index 12 is index 9
    expect(clampCut(text, 12)).toBe(9);
  });

  it('cuts mid-line at the limit for single-line blobs', () => {
    const text = 'x'.repeat(100);
    expect(clampCut(text, 40)).toBe(40);
  });

  it('ignores a pathologically early newline', () => {
    const text = 'ab\n' + 'x'.repeat(200);
    // only newline is at index 2, below limit/2 → cut at the limit instead
    expect(clampCut(text, 100)).toBe(100);
  });
});

describe('clampLabel', () => {
  it('reports KB and line count for small text', () => {
    expect(clampLabel('a'.repeat(2000) + '\nb')).toBe('2 KB, ~2 lines');
  });

  it('reports MB for large text', () => {
    expect(clampLabel('a'.repeat(2_400_000))).toBe('2.4 MB, ~1 lines');
  });
});

describe('mountCountFor', () => {
  it('keeps the current count when the index is already mounted', () => {
    expect(mountCountFor(10, 80, 500)).toBe(80);
  });

  it('overshoots the target index by a chunk, capped at total', () => {
    expect(mountCountFor(200, 80, 500)).toBe(200 + CHUNK_TURNS);
    expect(mountCountFor(490, 80, 500)).toBe(500);
  });
});
