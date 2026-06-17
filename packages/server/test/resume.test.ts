/**
 * "Continue session" command construction and guard logic. These are the
 * bug-prone edges: shell-quoting an arbitrary cwd (injection safety), the
 * per-connector resume/fork verbs, and the endpoint's pure decision matrix. The
 * impure launcher (`open`) is not exercised here.
 */

import { describe, expect, it } from 'vitest';
import {
  buildResumeInfo,
  displayCommand,
  launcherScript,
  resolveContinue,
  shQuote,
} from '../src/connectors/resume.js';
import { connectorById, connectors } from '../src/connectors/registry.js';

describe('shQuote', () => {
  it('leaves safe tokens bare so the command reads cleanly', () => {
    expect(shQuote('claude')).toBe('claude');
    expect(shQuote('--fork-session')).toBe('--fork-session');
    expect(shQuote('/Users/me/src/my-proj')).toBe('/Users/me/src/my-proj');
    expect(shQuote('ses_2132abc')).toBe('ses_2132abc');
  });

  it('single-quotes anything containing shell-special characters', () => {
    expect(shQuote('/tmp/my project')).toBe("'/tmp/my project'");
    expect(shQuote('/tmp/a$b')).toBe("'/tmp/a$b'");
    expect(shQuote('')).toBe("''");
  });

  it('neutralizes an embedded single quote (injection safety)', () => {
    expect(shQuote("O'Brien")).toBe("'O'\\''Brien'");
    // A cwd crafted to break out and run a command stays inert inside the quotes.
    expect(shQuote("/tmp/a'; rm -rf ~ #")).toBe("'/tmp/a'\\''; rm -rf ~ #'");
  });
});

describe('displayCommand', () => {
  it('builds a clean cd && agent line for a normal cwd', () => {
    expect(displayCommand('/tmp/projA', ['claude', '--resume', 'sessA'])).toBe(
      'cd /tmp/projA && claude --resume sessA',
    );
  });

  it('quotes a hostile cwd so nothing executes', () => {
    const cmd = displayCommand("/tmp/a'; rm -rf ~ #", ['claude', '--resume', 'id']);
    expect(cmd).toBe("cd '/tmp/a'\\''; rm -rf ~ #' && claude --resume id");
    // The injected `rm` is inside the quoted cd argument, not a second command.
    expect(cmd).not.toContain('&& rm');
  });
});

describe('launcherScript', () => {
  it('is a bash script that cds (guarded) and execs the agent', () => {
    const s = launcherScript('/tmp/projA', ['claude', '--resume', 'sessA']);
    expect(s.startsWith('#!/bin/bash\n')).toBe(true);
    expect(s).toContain('cd /tmp/projA || {');
    expect(s).toContain('exec claude --resume sessA');
  });

  it('keeps a hostile cwd inert in both the cd and the guard', () => {
    const s = launcherScript("/tmp/a'; rm -rf ~ #", ['pi', '--session', 'x']);
    expect(s).toContain("cd '/tmp/a'\\''; rm -rf ~ #' || {");
    expect(s).not.toMatch(/\nrm -rf/);
  });
});

describe('connector resumeSpec', () => {
  const specOf = (id: string) => connectorById(id).resumeSpec?.('SID');

  it('every registered connector exposes a resume command', () => {
    for (const c of connectors) {
      expect(c.resumeSpec, `${c.id} should implement resumeSpec`).toBeTypeOf('function');
      expect(c.resumeSpec!('SID')?.resumeArgv.length).toBeGreaterThan(0);
    }
  });

  it('maps each agent to its verified resume verb/flag', () => {
    expect(specOf('claude-code')?.resumeArgv).toEqual(['claude', '--resume', 'SID']);
    expect(specOf('codex')?.resumeArgv).toEqual(['codex', 'resume', 'SID']);
    expect(specOf('opencode')?.resumeArgv).toEqual(['opencode', '--session', 'SID']);
    expect(specOf('pi')?.resumeArgv).toEqual(['pi', '--session', 'SID']);
    expect(specOf('copilot')?.resumeArgv).toEqual(['copilot', '--resume', 'SID']);
    expect(specOf('junie')?.resumeArgv).toEqual(['junie', '--session-id', 'SID']);
  });

  it('offers fork only for agents with a verified CLI fork', () => {
    expect(specOf('claude-code')?.forkArgv).toEqual(['claude', '--resume', 'SID', '--fork-session']);
    expect(specOf('codex')?.forkArgv).toEqual(['codex', 'fork', 'SID']);
    expect(specOf('opencode')?.forkArgv).toEqual(['opencode', '--session', 'SID', '--fork']);
    expect(specOf('pi')?.forkArgv).toEqual(['pi', '--fork', 'SID']);
    // Copilot's only fork is a broken in-session slash command; Junie has none.
    expect(specOf('copilot')?.forkArgv).toBeUndefined();
    expect(specOf('junie')?.forkArgv).toBeUndefined();
  });
});

describe('buildResumeInfo', () => {
  const claude = connectorById('claude-code');

  it('produces resume + fork commands and reflects platform in canAutoOpen', () => {
    const info = buildResumeInfo(claude, 'sessA', '/tmp/projA', true);
    expect(info).toEqual({
      cwd: '/tmp/projA',
      resumeCommand: 'cd /tmp/projA && claude --resume sessA',
      forkCommand: 'cd /tmp/projA && claude --resume sessA --fork-session',
      canAutoOpen: true,
    });
    expect(buildResumeInfo(claude, 'sessA', '/tmp/projA', false)?.canAutoOpen).toBe(false);
  });

  it('omits forkCommand for a fork-less connector', () => {
    const info = buildResumeInfo(connectorById('copilot'), 'cop1', '/tmp/p', true);
    expect(info?.resumeCommand).toBe('cd /tmp/p && copilot --resume cop1');
    expect(info?.forkCommand).toBeUndefined();
  });

  it('returns undefined when the session has no cwd', () => {
    expect(buildResumeInfo(claude, 'sessA', null, true)).toBeUndefined();
    expect(buildResumeInfo(claude, 'sessA', '', true)).toBeUndefined();
  });
});

describe('resolveContinue (endpoint guards)', () => {
  const spec = { resumeArgv: ['claude', '--resume', 'id'], forkArgv: ['claude', '--resume', 'id', '--fork-session'] };
  const ok = { cwd: '/tmp/p', connectorLabel: 'Claude Code', isMac: true };

  it('rejects an invalid mode before anything else', () => {
    expect(resolveContinue(spec, { ...ok, mode: 'bogus' })).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects auto-open on non-macOS even for a valid request', () => {
    const r = resolveContinue(spec, { ...ok, mode: 'resume', isMac: false });
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.error).toMatch(/macOS/);
  });

  it('rejects when there is no spec or no cwd', () => {
    expect(resolveContinue(null, { ...ok, mode: 'resume' })).toMatchObject({ ok: false, status: 400 });
    expect(resolveContinue(spec, { ...ok, mode: 'resume', cwd: null })).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects fork when the connector has no fork argv', () => {
    const r = resolveContinue({ resumeArgv: ['copilot', '--resume', 'id'] }, { ...ok, mode: 'fork', connectorLabel: 'GitHub Copilot CLI' });
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.error).toMatch(/Fork is not supported/);
  });

  it('resolves the right argv for a valid resume and fork', () => {
    expect(resolveContinue(spec, { ...ok, mode: 'resume' })).toEqual({ ok: true, cwd: '/tmp/p', argv: spec.resumeArgv });
    expect(resolveContinue(spec, { ...ok, mode: 'fork' })).toEqual({ ok: true, cwd: '/tmp/p', argv: spec.forkArgv });
  });
});
