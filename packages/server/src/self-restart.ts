/**
 * Post-update self-heal for the daemon.
 *
 * A long-lived daemon keeps running old code (and an old index schema) after
 * the package is upgraded — `claudescope update` restarts it on the npm path,
 * but brew/nix and out-of-band upgrades leave it stale until a manual
 * `claudescope restart`. This module lets the daemon notice that the installed
 * `claudescope` on PATH reports a different version than the running process
 * and hand off to `<bin> restart` — the CLI already owns the race-free
 * stop → wait → start sequence, and the freshly installed CLI spawns its own
 * (new) server bundle.
 *
 * Detection spawns `<bin> version` (prints the bare version, no side effects)
 * rather than walking the filesystem for a package.json — that works the same
 * across npm symlinks, Homebrew Cellar symlinks, and Nix makeWrapper scripts.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { APP_VERSION, CLAUDESCOPE_HOME, autoRestartEnabled } from './config.js';
import { LOG_FILE } from './daemon.js';
import { isIndexReady, isReindexInFlight } from './data/index.js';

/** Records the last restart attempt (target version + timestamp) so a failed
 *  hand-off or an in-progress install never turns into a restart loop. */
export const SELF_RESTART_MARKER = join(CLAUDESCOPE_HOME, 'self-restart.json');

export interface RestartMarker {
  target: string;
  at: string;
}

/** At most one restart attempt per target version per window. */
const RETRY_WINDOW_MS = 60 * 60 * 1000;

/** What `claudescope version` prints when it worked — a bare x.y.z release.
 *  Anchored: `0.0.0-dev` (an npm-linked dev build on PATH) must never become a
 *  restart target, since the resulting dev daemon would never self-heal back. */
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Set once a hand-off has been spawned so a slow CLI is never spawned twice. */
let restartInitiated = false;

/** Resolve the `claudescope` bin from PATH. Null when it isn't installed there
 *  (e.g. npx-only usage) — the caller skips silently and retries next tick. */
export function resolveInstalledBin(
  pathEnv: string = process.env.PATH ?? '',
  platform: NodeJS.Platform = process.platform,
): string | null {
  const names =
    platform === 'win32' ? ['claudescope.cmd', 'claudescope.exe', 'claudescope'] : ['claudescope'];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Ask the installed bin its version by running `<bin> version`. Null when the
 *  spawn fails, hangs past the timeout, or prints something that isn't x.y.z. */
export function readInstalledVersion(bin: string, timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['version'],
      { timeout: timeoutMs, shell: process.platform === 'win32' },
      (err, stdout) => {
        if (err) return resolve(null);
        const v = stdout.trim();
        resolve(VERSION_RE.test(v) ? v : null);
      },
    );
  });
}

/** Read the loop-guard marker, or null if absent/corrupt. */
export function readMarker(): RestartMarker | null {
  if (!existsSync(SELF_RESTART_MARKER)) return null;
  try {
    return JSON.parse(readFileSync(SELF_RESTART_MARKER, 'utf8')) as RestartMarker;
  } catch {
    return null;
  }
}

/** Loop guard: restart only when the installed version really is a version,
 *  differs from the running one, and we haven't already tried restarting into
 *  this exact target within {@link RETRY_WINDOW_MS}. A different target (e.g.
 *  the user upgraded again, or downgraded) resets the guard. */
export function shouldSelfRestart(
  installed: string,
  running: string,
  marker: RestartMarker | null,
  now: number,
): boolean {
  if (!VERSION_RE.test(installed)) return false;
  if (installed === running) return false;
  if (marker && marker.target === installed) {
    const at = Date.parse(marker.at);
    if (Number.isFinite(at) && now - at < RETRY_WINDOW_MS) return false;
  }
  return true;
}

/**
 * Timer body: when the on-disk install is a different version, hand off to
 * `<bin> restart --no-open` (detached, output → daemon log) and let the new
 * CLI SIGTERM this process. Skips: dev builds, CLAUDESCOPE_AUTO_RESTART=0, a
 * hand-off already in flight, a reindex pass in progress (never interrupt a
 * build), an unresolvable install, and the marker's retry window.
 */
export async function maybeSelfRestart(log: (msg: string) => void): Promise<void> {
  if (APP_VERSION === '0.0.0-dev' || !autoRestartEnabled()) return;
  if (restartInitiated) return;
  if (isReindexInFlight() || !isIndexReady()) return;

  const bin = resolveInstalledBin();
  if (!bin) return;
  const installed = await readInstalledVersion(bin);
  if (!installed) return;
  if (!shouldSelfRestart(installed, APP_VERSION, readMarker(), Date.now())) return;

  // A reindex pass may have started while we probed the installed version
  // (up to 5s) — never SIGTERM the daemon mid-pass; the next tick retries.
  if (isReindexInFlight() || !isIndexReady()) return;

  // Write the marker BEFORE spawning: if the hand-off wedges or crashes, the
  // guard still rate-limits retries to one per target per hour.
  writeFileSync(
    SELF_RESTART_MARKER,
    JSON.stringify({ target: installed, at: new Date().toISOString() }, null, 2),
  );
  log(
    `installed claudescope is v${installed}, this daemon is v${APP_VERSION} — ` +
      'restarting into the new version',
  );
  try {
    // Detached + unref: the child survives this process's SIGTERM (own process
    // group). `restart` stops this daemon, waits for the port, starts the new one.
    const logFd = openSync(LOG_FILE, 'a');
    const child = spawn(bin, ['restart', '--no-open'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => {
      log(`self-restart hand-off failed to spawn: ${err.message}`);
      restartInitiated = false; // marker still rate-limits the retry
    });
    child.unref();
    restartInitiated = true;
  } catch (err) {
    log(`self-restart hand-off failed: ${err instanceof Error ? err.message : String(err)}`);
    restartInitiated = false;
  }
}
