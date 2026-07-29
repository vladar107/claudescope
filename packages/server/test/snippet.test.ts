import { describe, expect, it } from 'vitest';
import { makeSnippet } from '../src/routes/snippet.js';

describe('makeSnippet', () => {
  const text = 'config uses <env> & "quotes" around the needle here';

  it('html format escapes entities and wraps matches in <mark>', () => {
    const s = makeSnippet(text, ['needle']);
    expect(s).toContain('<mark>needle</mark>');
    expect(s).toContain('&lt;env&gt;');
    expect(s).toContain('&amp;');
  });

  it('plain format returns raw text — no marks, no escaping', () => {
    const s = makeSnippet(text, ['needle'], 'plain');
    expect(s).toContain('<env> & "quotes"');
    expect(s).not.toContain('<mark>');
    expect(s).not.toContain('&lt;');
  });

  it('matches a term that itself contains an HTML-escaped char', () => {
    // The term is matched against the ESCAPED window in html mode — the
    // regex must target `&lt;env&gt;`, not `<env>`.
    const s = makeSnippet(text, ['<env>']);
    expect(s).toContain('<mark>&lt;env&gt;</mark>');
    expect(makeSnippet(text, ['<env>'], 'plain')).toContain('<env>');
  });

  it('windows long text around the first match with ellipses', () => {
    const long = 'a'.repeat(500) + ' target ' + 'b'.repeat(500);
    const s = makeSnippet(long, ['target'], 'plain');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('target');
    // Window is SNIPPET_RADIUS before + 2×SNIPPET_RADIUS after the match (+ ellipses).
    expect(s.length).toBeLessThanOrEqual(362);
  });

  it('does not let one term match markup another term inserted', () => {
    // The regression: marking used to run one regex replace per term over the
    // ALREADY-marked string, so `mark` matched the `<mark>` tags `book` had just
    // produced — `the <<mark>mark</mark>>book</<mark>mark</mark>>...`.
    const s = makeSnippet('the bookmark is here', ['book', 'mark']);
    expect(s).toBe('the <mark>bookmark</mark> is here');
    expect(s).not.toContain('<<');
    expect(s).not.toContain('</<');
  });

  it('merges overlapping matches into one mark instead of nesting them', () => {
    expect(makeSnippet('abcd', ['abc', 'bcd'])).toBe('<mark>abcd</mark>');
  });

  it('marks every occurrence, preserving the original casing', () => {
    expect(makeSnippet('MARK this and mark that', ['mark'])).toBe(
      '<mark>MARK</mark> this and <mark>mark</mark> that',
    );
  });

  it('escapes transcript content even inside a match', () => {
    // A term matching text with HTML metacharacters must still be escaped —
    // only the two literal <mark> strings are ever emitted unescaped.
    expect(makeSnippet('a <img> b', ['<img>'])).toBe('a <mark>&lt;img&gt;</mark> b');
  });

  it('treats regex metacharacters in a term literally', () => {
    // Matching is now indexOf-based, so there is no pattern to escape at all.
    expect(makeSnippet('cost is 1+1 dollars', ['1+1'])).toContain('<mark>1+1</mark>');
    expect(makeSnippet('a.b and axb', ['a.b'])).toBe('<mark>a.b</mark> and axb');
  });
});
