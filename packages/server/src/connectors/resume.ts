/**
 * Pure command construction for "continue session" — kept side-effect-free so it
 * can be unit-tested without spawning anything. The impure part (writing the
 * launcher and `open`-ing it) lives in `util/terminal.ts`.
 *
 * Security note: every interpolated value is shell-quoted here, and the only
 * input that isn't a fixed argv token is the session's own indexed `cwd`. The
 * HTTP layer never accepts a command string from the client — it sends a `mode`
 * and the server rebuilds argv from the connector — so a hostile `cwd` is the
 * only injection surface, and `shQuote` neutralizes it.
 */

import type { ResumeInfo } from '@claudescope/shared';
import type { AgentConnector, ResumeSpec } from './types.js';

/** Characters safe to leave unquoted in a POSIX shell (the shlex.quote allowlist). */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a string for a POSIX shell, shlex-style: leave it bare when it's only
 * safe characters (so the common command reads cleanly), otherwise single-quote
 * it and neutralize any embedded quote with `'\''`. This is the injection guard
 * for the session's `cwd`.
 */
export function shQuote(s: string): string {
  if (s === '') return "''";
  if (SHELL_SAFE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote an argv into a single command fragment. */
function quoteArgv(argv: string[]): string {
  return argv.map(shQuote).join(' ');
}

/** The copy-paste command: cd into the project, then run the agent. */
export function displayCommand(cwd: string, argv: string[]): string {
  return `cd ${shQuote(cwd)} && ${quoteArgv(argv)}`;
}

/**
 * A macOS `.command` launcher: a tiny bash script that cds into the project and
 * execs the agent. `open`ing this routes it to the user's default terminal (the
 * handler registered for `.command`), which runs it in a login shell — so the
 * agent binary resolves on PATH as it normally would.
 */
export function launcherScript(cwd: string, argv: string[]): string {
  return [
    '#!/bin/bash',
    // No path interpolation in the message → nothing to escape; the cd target is quoted.
    `cd ${shQuote(cwd)} || { echo "claudescope: project directory not found"; exit 1; }`,
    `exec ${quoteArgv(argv)}`,
    '',
  ].join('\n');
}

/**
 * Assemble the client-facing {@link ResumeInfo} for a session, or `undefined`
 * when it can't be resumed (no cwd, or the connector has no resume command).
 */
export function buildResumeInfo(
  connector: AgentConnector,
  sessionId: string,
  cwd: string | null,
  isMac: boolean,
): ResumeInfo | undefined {
  if (!cwd) return undefined;
  const spec = connector.resumeSpec?.(sessionId);
  if (!spec) return undefined;
  const info: ResumeInfo = {
    cwd,
    resumeCommand: displayCommand(cwd, spec.resumeArgv),
    canAutoOpen: isMac,
  };
  if (spec.forkArgv) info.forkCommand = displayCommand(cwd, spec.forkArgv);
  return info;
}

/** Outcome of validating a /continue request — either the argv to launch, or an error. */
export type ContinueResolution =
  | { ok: true; cwd: string; argv: string[] }
  | { ok: false; status: number; error: string };

/**
 * Pure guard logic for the auto-open endpoint. Resolves the argv to launch or an
 * HTTP error, so the route stays thin and the rules are testable without
 * touching the filesystem or spawning `open`. (The 404 for an unknown session is
 * handled in the route, before this is reached.)
 */
export function resolveContinue(
  spec: ResumeSpec | null | undefined,
  opts: { cwd: string | null; mode: string; connectorLabel: string; isMac: boolean },
): ContinueResolution {
  if (opts.mode !== 'resume' && opts.mode !== 'fork') {
    return { ok: false, status: 400, error: "mode must be 'resume' or 'fork'" };
  }
  if (!opts.isMac) {
    return {
      ok: false,
      status: 400,
      error: 'Auto-open is only available on macOS — copy the command and run it yourself.',
    };
  }
  if (!spec || !opts.cwd) {
    return { ok: false, status: 400, error: 'This session cannot be resumed.' };
  }
  const argv = opts.mode === 'fork' ? spec.forkArgv : spec.resumeArgv;
  if (!argv) {
    return { ok: false, status: 400, error: `Fork is not supported for ${opts.connectorLabel}.` };
  }
  return { ok: true, cwd: opts.cwd, argv };
}
