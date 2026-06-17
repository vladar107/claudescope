/**
 * macOS terminal launcher for "continue session". Writes a `.command` script to
 * the app state dir and `open`s it, which routes it to the user's default
 * terminal (the registered handler for `.command`). Isolated here so the route's
 * decision logic stays pure and testable; this module is the only side effect.
 */

import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAUNCHERS_DIR } from '../config.js';
import { launcherScript } from '../connectors/resume.js';

/**
 * Write the launcher for `(sessionId, mode)` and open it. We deliberately do NOT
 * check whether the agent binary exists or the session is resolvable — a missing
 * binary or unknown session surfaces as a visible error in the opened terminal.
 */
export function launchTerminal(
  sessionId: string,
  mode: 'resume' | 'fork',
  cwd: string,
  argv: string[],
): void {
  mkdirSync(LAUNCHERS_DIR, { recursive: true });
  // Session ids can carry `/`, `#`, etc. (e.g. opencode keys); make a safe filename.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'session';
  const file = join(LAUNCHERS_DIR, `${mode}-${safe}.command`);
  writeFileSync(file, launcherScript(cwd, argv), { mode: 0o700 });
  chmodSync(file, 0o700); // ensure the exec bit even if umask stripped it
  const child = spawn('open', [file], { detached: true, stdio: 'ignore' });
  // A ChildProcess that emits 'error' (e.g. `open` not spawnable) with no
  // listener throws an uncaught exception — fatal for the long-lived daemon.
  child.on('error', (err) => console.error('[continue] failed to open terminal:', err));
  child.unref();
}
