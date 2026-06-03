import { describe, expect, it } from 'vitest';
import { lineDiff } from '../src/components/diff.js';

describe('lineDiff', () => {
  it('marks all lines as context when unchanged', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([
      { type: 'context', text: 'a' },
      { type: 'context', text: 'b' },
    ]);
  });

  it('detects a single changed line as del + add around context', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(d).toEqual([
      { type: 'context', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('handles pure additions and deletions', () => {
    expect(lineDiff('', 'x')).toEqual([
      { type: 'del', text: '' },
      { type: 'add', text: 'x' },
    ]);
    expect(lineDiff('keep\ngone', 'keep')).toEqual([
      { type: 'context', text: 'keep' },
      { type: 'del', text: 'gone' },
    ]);
  });

  it('preserves added lines in the middle', () => {
    const d = lineDiff('a\nc', 'a\nb\nc');
    expect(d).toEqual([
      { type: 'context', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'context', text: 'c' },
    ]);
  });

  it('counts added vs removed lines correctly on a larger edit', () => {
    const d = lineDiff('one\ntwo\nthree', 'one\ntwo changed\nthree\nfour');
    expect(d.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['two changed', 'four']);
    expect(d.filter((l) => l.type === 'del').map((l) => l.text)).toEqual(['two']);
  });
});
