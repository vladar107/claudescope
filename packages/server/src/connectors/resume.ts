/**
 * Pure command construction for "continue session" — builds the copy-paste
 * command that reopens a session in its agent's own CLI. Side-effect-free and
 * fully unit-tested; the server only ever hands these strings to the UI to
 * display, never executes them.
 *
 * Security note: the only free-form input is the session's own indexed `cwd`,
 * and `shQuote` neutralizes it — so even if the user copies and runs the
 * command, a hostile cwd can't break out of the `cd` argument.
 */

import type { ResumeInfo } from '@claudescope/shared';
import type { AgentConnector } from './types.js';

/** Characters safe to leave unquoted in a POSIX shell (the shlex.quote allowlist). */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a string for a POSIX shell, shlex-style: leave it bare when it's only
 * safe characters (so the command reads cleanly), otherwise single-quote it and
 * neutralize any embedded quote with `'\''`. This is the injection guard for the
 * session's `cwd`.
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
 * Assemble the client-facing {@link ResumeInfo} for a session, or `undefined`
 * when it can't be resumed (no cwd, or the connector has no resume command).
 */
export function buildResumeInfo(
  connector: AgentConnector,
  sessionId: string,
  cwd: string | null,
): ResumeInfo | undefined {
  if (!cwd) return undefined;
  const spec = connector.resumeSpec?.(sessionId);
  if (!spec) return undefined;
  const info: ResumeInfo = {
    cwd,
    resumeCommand: displayCommand(cwd, spec.resumeArgv),
  };
  if (spec.forkArgv) info.forkCommand = displayCommand(cwd, spec.forkArgv);
  return info;
}
