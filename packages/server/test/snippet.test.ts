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
});
