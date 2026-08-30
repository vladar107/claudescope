import { describe, expect, it } from 'vitest';
import { cleanFallbackTitle, TITLE_MAX_LENGTH } from '../src/data/title.js';

describe('cleanFallbackTitle', () => {
  it('returns empty for empty/nullish input', () => {
    expect(cleanFallbackTitle('')).toBe('');
    expect(cleanFallbackTitle(null)).toBe('');
    expect(cleanFallbackTitle(undefined)).toBe('');
    expect(cleanFallbackTitle('   \n\t  ')).toBe('');
  });

  it('strips leading markdown heading markers', () => {
    expect(cleanFallbackTitle('# Fix the indexer bug')).toBe('Fix the indexer bug');
    expect(cleanFallbackTitle('### deeply nested heading')).toBe('deeply nested heading');
  });

  it('strips surrounding markdown emphasis', () => {
    expect(cleanFallbackTitle('**Bold ask**')).toBe('Bold ask');
    expect(cleanFallbackTitle('`run the build`')).toBe('run the build');
    expect(cleanFallbackTitle('_make it faster_')).toBe('make it faster');
  });

  it('strips wrapper/XML-ish tags inline', () => {
    expect(cleanFallbackTitle('<INSTRUCTIONS>do the thing</INSTRUCTIONS>')).toBe('do the thing');
  });

  it('skips a clearly injected instructions blob and uses the real prose line', () => {
    const raw = [
      '# AGENTS.md instructions for /Users/vramazaev/src/transript-viewer',
      '<INSTRUCTIONS>',
      'Please add a fallback title cleaner',
      '</INSTRUCTIONS>',
    ].join('\n');
    expect(cleanFallbackTitle(raw)).toBe('Please add a fallback title cleaner');
  });

  it('skips the pathless Codex instructions heading', () => {
    const raw = [
      '# AGENTS.md instructions',
      '<INSTRUCTIONS>',
      '</INSTRUCTIONS>',
      'Restore the real session name',
    ].join('\n');
    expect(cleanFallbackTitle(raw)).toBe('Restore the real session name');
  });

  it('does not broadly classify other instruction headings as injected', () => {
    expect(cleanFallbackTitle('# Project instructions\nKeep this heading visible')).toBe(
      'Project instructions',
    );
    expect(cleanFallbackTitle('# Project instructions for /tmp\nKeep the real prompt')).toBe(
      'Keep the real prompt',
    );
  });

  it('skips lone wrapper tag lines and system-reminder preambles', () => {
    const raw = [
      '<system-reminder>',
      'Caveat: the harness injected this',
      '',
      'Refactor the connector registry',
    ].join('\n');
    expect(cleanFallbackTitle(raw)).toBe('Refactor the connector registry');
  });

  it('collapses internal whitespace and newlines to single spaces', () => {
    expect(cleanFallbackTitle('hello   world')).toBe('hello world');
    expect(cleanFallbackTitle('keep\tthe tabs   tidy')).toBe('keep the tabs tidy');
  });

  it('truncates long titles with an ellipsis, never exceeding the max length', () => {
    const long = 'a'.repeat(200);
    const out = cleanFallbackTitle(long);
    expect(out.length).toBe(TITLE_MAX_LENGTH);
    expect(out.endsWith('…')).toBe(true);
    expect(out.startsWith('aaaa')).toBe(true);
  });

  it('does not truncate when at or under the limit', () => {
    const exact = 'x'.repeat(TITLE_MAX_LENGTH);
    expect(cleanFallbackTitle(exact)).toBe(exact);
    expect(cleanFallbackTitle(exact).endsWith('…')).toBe(false);
  });

  it('trims a dangling space before the ellipsis on truncation', () => {
    // Build text whose clip boundary lands right after a space, so a naive
    // slice would yield "… " — the cleaner must trim it.
    const word = 'word ';
    const raw = word.repeat(40); // well over the limit, space-separated
    const out = cleanFallbackTitle(raw);
    expect(out.endsWith(' …')).toBe(false);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is deterministic: same input twice yields identical output', () => {
    const raw = '# AGENTS.md instructions for /x\n<INSTRUCTIONS>\nDo work\n</INSTRUCTIONS>';
    expect(cleanFallbackTitle(raw)).toBe(cleanFallbackTitle(raw));
  });

  it('falls back to the first non-empty line when no line is clean prose', () => {
    // A single injected line with no prose alternative still yields something
    // usable (its stripped text) rather than an empty title.
    expect(cleanFallbackTitle('<INSTRUCTIONS>only a wrapped blob</INSTRUCTIONS>')).toBe(
      'only a wrapped blob',
    );
  });
});
