import { describe, expect, it } from 'vitest';
import { readRow } from '../src/db/row.js';

describe('readRow', () => {
  it('throws when a referenced column is absent (alias drift)', () => {
    const rd = readRow({ a: 1 }, 'ctx');
    expect(() => rd.num('missing')).toThrow(/expected column 'missing'/);
    expect(() => rd.str('missing')).toThrow(/ctx/);
    expect(() => rd.req('missing')).toThrow();
  });

  it('distinguishes a present-null column from an absent one', () => {
    const rd = readRow({ present: null }, 'ctx');
    expect(rd.req('present')).toBeNull(); // present → returns null, no throw
    expect(() => rd.req('absent')).toThrow();
  });

  it('returns the fallback for a present-but-null value', () => {
    const rd = readRow({ title: null, n: null }, 'ctx');
    expect(rd.str('title')).toBe('');
    expect(rd.str('title', 'x')).toBe('x');
    expect(rd.num('n')).toBe(0);
    expect(rd.num('n', 7)).toBe(7);
  });

  it('coerces present values', () => {
    const rd = readRow({ s: 42, n: '3.5', b: true, z: 0 }, 'ctx');
    expect(rd.str('s')).toBe('42');
    expect(rd.num('n')).toBe(3.5);
    expect(rd.bool('b')).toBe(true);
    expect(rd.bool('z')).toBe(false); // present but falsy
  });

  it('num falls back on a non-finite value', () => {
    const rd = readRow({ bad: 'not-a-number' }, 'ctx');
    expect(rd.num('bad')).toBe(0);
    expect(rd.num('bad', -1)).toBe(-1);
  });

  it('opt returns undefined for an absent column without throwing', () => {
    const rd = readRow({ a: 1 }, 'ctx');
    expect(rd.opt('missing')).toBeUndefined();
    expect(rd.opt('a')).toBe(1);
  });
});
