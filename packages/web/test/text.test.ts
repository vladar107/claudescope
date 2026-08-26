import { describe, expect, it } from 'vitest';
import {
  classifySystemText,
  isInheritedCodexContext,
  parseCommandTurn,
  stripAnsi,
  stripImageMarkers,
} from '../src/pages/session/text.js';

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

describe('isInheritedCodexContext', () => {
  const inheritedTurn = `# AGENTS.md instructions for /repo

<INSTRUCTIONS>
Parent instructions
</INSTRUCTIONS>
<environment_context>
  <cwd>/repo</cwd>
</environment_context>

Original parent prompt`;

  it('classifies a complete Codex startup envelope on a sidechain', () => {
    expect(isInheritedCodexContext(inheritedTurn, true)).toBe(true);
  });

  it('leaves the same startup envelope unchanged on a top-level turn', () => {
    expect(isInheritedCodexContext(inheritedTurn, false)).toBe(false);
  });

  it('leaves ordinary sidechain user prose unchanged', () => {
    expect(isInheritedCodexContext('Please inspect the parser.', true)).toBe(false);
  });

  it('fails closed when a startup wrapper is incomplete', () => {
    expect(
      isInheritedCodexContext(
        '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>Parent instructions',
        true,
      ),
    ).toBe(false);
    expect(
      isInheritedCodexContext('<environment_context><cwd>/repo</cwd>', true),
    ).toBe(false);
  });
});

describe('stripAnsi', () => {
  it('removes SGR colour codes but keeps the text', () => {
    expect(stripAnsi('Kept model as [1mOpus 4.7[22m')).toBe('Kept model as Opus 4.7');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here');
  });
});

describe('parseCommandTurn', () => {
  it('parses a slash command with empty args', () => {
    // The redundant <command-message> and the 12-space indentation are dropped.
    const raw =
      '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';
    expect(parseCommandTurn(raw)).toEqual({ kind: 'slash', name: '/clear', args: '' });
  });

  it('parses a slash command with args', () => {
    const raw =
      '<command-name>/plugin</command-name>\n            <command-message>plugin</command-message>\n            <command-args>marketplace add foo/bar</command-args>';
    expect(parseCommandTurn(raw)).toEqual({
      kind: 'slash',
      name: '/plugin',
      args: 'marketplace add foo/bar',
    });
  });

  it('parses a bash-input turn', () => {
    expect(parseCommandTurn('<bash-input>git pull</bash-input>')).toEqual({
      kind: 'bash-input',
      command: 'git pull',
    });
  });

  it('parses multiline bash-stdout and keeps the newlines', () => {
    const raw = '<bash-stdout>line one\nline two</bash-stdout><bash-stderr></bash-stderr>';
    expect(parseCommandTurn(raw)).toEqual({
      kind: 'bash-output',
      stdout: 'line one\nline two',
      stderr: '',
    });
  });

  it('parses a stderr-only bash output', () => {
    const raw = "<bash-stdout></bash-stdout><bash-stderr>error: nope\n</bash-stderr>";
    expect(parseCommandTurn(raw)).toEqual({
      kind: 'bash-output',
      stdout: '',
      stderr: 'error: nope\n',
    });
  });

  it('strips ANSI codes from local-command output', () => {
    const raw = '<local-command-stdout>Kept model as [1mOpus 4.7[22m</local-command-stdout>';
    expect(parseCommandTurn(raw)).toEqual({ kind: 'local-output', text: 'Kept model as Opus 4.7' });
  });

  it('returns null on a truncated/unclosed tag (graceful fallback to raw)', () => {
    expect(parseCommandTurn('<bash-input>git pull')).toBeNull();
    expect(parseCommandTurn('<command-name>/clear')).toBeNull();
  });

  it('returns null for non-command text and plain-text slash (other agents)', () => {
    // pi stores `/exit` as plain text, not a tag — must not be mistaken for a command turn.
    expect(parseCommandTurn('/exit')).toBeNull();
    expect(parseCommandTurn('please fix the bug')).toBeNull();
    expect(parseCommandTurn('<system-reminder>noise</system-reminder>')).toBeNull();
  });
});
