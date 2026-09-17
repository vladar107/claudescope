/**
 * `skillNamesCsv` — the read-based half of the skill-load signal. The regex is
 * the whole contract for Codex, pi, Copilot and Antigravity, so its edges are
 * what can silently fabricate or lose a load: nested pi layouts, JSON-escaped
 * Windows paths, files that merely look like SKILL.md, glob and traversal
 * segments (which would break the CSV or invent a skill), and calls that name
 * the path without loading it.
 */

import { describe, expect, it } from 'vitest';
import { skillNamesCsv } from '../src/connectors/skill-names.js';

const use = (name: string, input: unknown) => ({ type: 'tool_use', name, input });

describe('skillNamesCsv — SKILL.md reads', () => {
  it('names the directory, however deep, for any reading call', () => {
    expect(skillNamesCsv([use('Read', { path: '/h/.pi/agent/skills/group/foo/SKILL.md' })])).toBe('foo');
    expect(skillNamesCsv([use('Bash', { command: 'cat ~/.codex/skills/now/SKILL.md' })])).toBe('now');
    expect(skillNamesCsv([use('exec', { script: 'read("C:\\\\Users\\\\me\\\\.codex\\\\skills\\\\win\\\\SKILL.md")' })])).toBe('win');
    expect(skillNamesCsv([use('view_file', { AbsolutePath: '/h/skills/my-skill.v2/SKILL.md' })])).toBe('my-skill.v2');
    // Relative paths in a shell command, with and without a plugin layout.
    expect(skillNamesCsv([use('exec', { cmd: 'sed -n 1,80p plugins/claudescope/skills/history/SKILL.md' })])).toBe('claudescope:history');
    expect(skillNamesCsv([use('Bash', { command: 'cat skills/foo/SKILL.md' })])).toBe('foo');
    expect(skillNamesCsv([use('Bash', { command: 'cat myskills/foo/SKILL.md' })])).toBe('');
  });

  it('namespaces a read inside a plugin cache as plugin:skill, for either agent layout', () => {
    expect(skillNamesCsv([use('Read', { path: '/h/.codex/plugins/cache/claudescope/claudescope/1.1.0/skills/history/SKILL.md' })])).toBe('claudescope:history');
    expect(skillNamesCsv([use('Bash', { command: 'cat /h/.claude/plugins/cache/revdiff/revdiff/0.8.23/.claude-plugin/skills/revdiff/SKILL.md' })])).toBe('revdiff:revdiff');
    expect(skillNamesCsv([use('Read', { path: 'C:\\Users\\me\\.codex\\plugins\\cache\\mkt\\tool\\1.0.0\\skills\\win\\SKILL.md' })])).toBe('tool:win');
    // A plugin under development in a marketplace repo is the same plugin.
    expect(skillNamesCsv([use('Read', { path: '/repo/plugins/claudescope/skills/history/SKILL.md' })])).toBe('claudescope:history');
    expect(skillNamesCsv([use('Read', { path: '/repo/plugins/revdiff/.claude-plugin/skills/revdiff/SKILL.md' })])).toBe('revdiff:revdiff');
    // No plugin layout in front: a plain skill.
    expect(skillNamesCsv([use('Read', { path: '/repo/.claude/skills/history/SKILL.md' })])).toBe('history');
  });

  it('ignores look-alikes: other files, globs, traversal, commas', () => {
    expect(skillNamesCsv([use('Read', { path: '/h/skills/foo/SKILL.md.bak' })])).toBe('');
    expect(skillNamesCsv([use('Read', { path: '/h/skills/foo/skill.md' })])).toBe('');
    expect(skillNamesCsv([use('Bash', { command: 'ls ~/.codex/skills/*/SKILL.md' })])).toBe('');
    expect(skillNamesCsv([use('Read', { path: '/h/skills/../SKILL.md' })])).toBe('');
    expect(skillNamesCsv([use('Read', { path: '/h/skills/a,b/SKILL.md' })])).toBe('');
    expect(skillNamesCsv([use('Bash', { command: 'cat ~/.codex/skills/$name/SKILL.md' })])).toBe('');
  });

  it('does not count writes, delegations or fetches that mention the path', () => {
    expect(skillNamesCsv([use('Write', { file_path: '/h/.claude/skills/new/SKILL.md', content: '' })])).toBe('');
    expect(skillNamesCsv([use('Task', { prompt: 'Read ~/.codex/skills/foo/SKILL.md first' })])).toBe('');
    expect(skillNamesCsv([use('WebFetch', { url: 'https://x/y/skills/foo/SKILL.md' })])).toBe('');
  });

  it('counts a skill once per block and keeps a native Skill call out of the regex', () => {
    expect(skillNamesCsv([use('Bash', { command: 'cat a/skills/foo/SKILL.md b/skills/foo/SKILL.md' })])).toBe('foo');
    expect(skillNamesCsv([use('Skill', { skill: 'now', path: '/h/.junie/skills/now/SKILL.md' })])).toBe('now');
    expect(skillNamesCsv([use('Skill', { skill: '' }), use('Skill', { skill: 'a,b' })])).toBe('');
  });
});
