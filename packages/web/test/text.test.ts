import { describe, expect, it } from 'vitest';
import { classifySystemText, stripImageMarkers } from '../src/pages/session/text.js';

describe('stripImageMarkers', () => {
  it('removes an inline [Image #N] marker but keeps the message', () => {
    expect(stripImageMarkers('is it ok?[Image #1]')).toBe('is it ok?');
  });

  it('reduces a standalone [Image: source: …] turn to empty', () => {
    expect(
      stripImageMarkers('[Image: source: /Users/x/.claude/image-cache/abc/1.png]'),
    ).toBe('');
  });

  it('removes a bare [Image #1]', () => {
    expect(stripImageMarkers('[Image #1]')).toBe('');
  });

  it('leaves normal text untouched', () => {
    const t = 'A real message with [brackets] but no image markers.';
    expect(stripImageMarkers(t)).toBe(t);
  });

  it('strips multiple markers of both forms', () => {
    expect(stripImageMarkers('See [Image #2] and [Image: source: /x/y.png] end')).toContain('See');
    expect(stripImageMarkers('See [Image #2] and [Image: source: /x/y.png] end')).not.toContain('Image');
  });
});

describe('classifySystemText', () => {
  it('labels harness-injected turns by their leading tag', () => {
    expect(classifySystemText('<task-notification>...')).toBe('Task notification');
    expect(classifySystemText('<system-reminder>...')).toBe('System reminder');
    expect(classifySystemText('<bash-input>npm test</bash-input>')).toBe('Bash input');
    expect(classifySystemText('<bash-stdout>ok</bash-stdout>')).toBe('Bash output');
  });

  it('tolerates leading whitespace', () => {
    expect(classifySystemText('\n  <task-notification>x')).toBe('Task notification');
  });

  it('returns null for ordinary user text', () => {
    expect(classifySystemText('please fix the bug')).toBeNull();
    expect(classifySystemText('here is some <html> in my message')).toBeNull();
  });
});
