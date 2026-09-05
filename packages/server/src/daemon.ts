/**
 * Daemon lifecycle primitives, shared by the user-facing CLI commands
 * (`start`/`stop`/`status`/… in cli.ts) and the MCP server (`claudescope mcp`),
 * which must silently ensure a daemon is running before it can proxy queries.
 *
 * The daemon is one detached server process tracked by `daemon.json` in the
 * state dir. Everything here writes progress to callbacks or stderr — never to
 * stdout, which an MCP stdio server owns as its protocol channel.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthResponse } from '@claudescope/shared';
import {
  APP_VERSION,
  CLAUDESCOPE_HOME,
  PORT as DEFAULT_PORT,
  STATE_FILE_MODE,
  autoRestartEnabled,
  ensureStateDir,
} from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The server bundle, a sibling of the CLI in the published package. */
export const SERVER_ENTRY = join(__dirname, 'server.js');
export const DAEMON_FILE = join(CLAUDESCOPE_HOME, 'daemon.json');
export const LOG_FILE = join(CLAUDESCOPE_HOME, 'daemon.log');
/** Roll the append-only daemon log once it grows past this, so a long-lived or
 *  crash-looping daemon doesn't grow the log without bound. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** How long to wait for a signalled process to actually exit before giving up.
 *  The server's own SIGTERM handler drains an in-flight index pass before it
 *  exits, so its drain budget (`DRAIN_MS` in shutdown.ts) is deliberately sized
 *  to fit inside this window — a graceful stop must never look like a hang. */
export const EXIT_WAIT_MS = 5000;

export interface DaemonRecord {
  pid: number;
  port: number;
  url: string;
  version: string;
  startedAt: string;
}

/** Read the daemon record, or null if absent/corrupt. */
export function readDaemon(): DaemonRecord | null {
  if (!existsSync(DAEMON_FILE)) return null;
  try {
    return JSON.parse(readFileSync(DAEMON_FILE, 'utf8')) as DaemonRecord;
  } catch {
    return null;
  }
}

/** Is a process with this PID currently alive? */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a live PID really belongs to a Claudescope daemon — `'unknown'` when
 * we could not find out.
 *
 * `isAlive` only proves *something* holds the PID. After a crash leaves
 * `daemon.json` behind and the OS recycles that PID, it belongs to an unrelated
 * process — and the `wedged` branch's whole job is to SIGTERM it. So callers must
 * confirm ownership first, and treat `'unknown'` as "do not signal": failing
 * loudly beats killing a process we cannot identify.
 *
 * Implemented by reading the process's command line, which is the one signal
 * that survives a crash (Node exposes no start-time API for an arbitrary PID).
 *
 * The match requires BOTH `claudescope` and the server bundle's filename, rather
 * than this CLI's exact {@link SERVER_ENTRY} path — an upgrade or a brew/nix
 * relocation moves that path, so pinning it would produce false negatives. Both
 * halves are needed: `claudescope` alone also matches a sibling CLI invocation
 * (`claudescope mcp`, `claudescope search`) and, in a dev checkout, any process
 * launched from a directory named `claudescope`. A false negative is safe — we
 * skip the kill and get a clear `EADDRINUSE` instead — whereas a false positive
 * is exactly the bug this closes.
 */
export function daemonOwnsPid(pid: number): boolean | 'unknown' {
  const [cmd, args] =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ],
        ]
      : ['ps', ['-o', 'args=', '-p', String(pid)]];
  let out: string;
  try {
    out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // `ps` exits non-zero for an unknown PID — but by the time we get here the
    // process was alive, so this is a probe failure (missing binary, timeout, no
    // permission), not evidence either way.
    return 'unknown';
  }
  const line = out.trim().toLowerCase();
  if (line === '') return 'unknown';
  return line.includes('claudescope') && line.includes(basename(SERVER_ENTRY).toLowerCase());
}

/** Probe the server's health endpoint (short timeout, never throws). */
export async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll health until ready or the deadline; `onTick` fires per attempt (the CLI
 *  prints progress dots with it). */
export async function waitForHealth(
  port: number,
  timeoutMs: number,
  onTick?: () => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy(port)) return true;
    onTick?.();
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Poll until the process is gone or the deadline; returns whether it exited. */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

/** Fetch and parse the daemon's /api/health (short timeout). Null on any
 *  failure — unreachable, non-ok, or unparsable — so callers treat "no info"
 *  and "no daemon" the same way. */
export async function fetchDaemonHealth(port: number): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

/**
 * The single choke point for signalling a PID recorded in daemon.json: every
 * caller (`stop`, `restart`, `update`, the wedged path, the version-skew heal)
 * goes through here, so ownership is checked exactly once and in one place —
 * {@link planWedgeAction} decides, and only a `replace` verdict is ever
 * signalled. `discard` drops the recycled record without touching the process.
 * `refuse` comes back unsignalled with the record kept, and the caller decides
 * how to report it: `stop` fails, while the version-skew heal adopts the daemon
 * it just saw answer /api/health — only killing needs certainty. On `replace`:
 * SIGTERM, wait for the process to actually exit, and clear daemon.json (so a
 * follow-up spawn can rebind the port). Throws only when a signalled process
 * refuses to die within {@link EXIT_WAIT_MS} (with a kill -9 hint). Callers
 * that already hold a verdict pass `() => verdict` so the `ps` probe runs once.
 */
export async function terminateDaemon(
  record: DaemonRecord,
  owns: (pid: number) => boolean | 'unknown' = daemonOwnsPid,
): Promise<WedgeAction> {
  const action = planWedgeAction(record, owns(record.pid));
  if (action.kind === 'refuse') return action;
  if (action.kind === 'discard') {
    rmSync(DAEMON_FILE, { force: true });
    return action;
  }
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  if (!(await waitForExit(record.pid, EXIT_WAIT_MS))) {
    throw new Error(
      `could not stop the claudescope daemon (pid ${record.pid}); ` +
        `kill it manually and retry: kill -9 ${record.pid}`,
    );
  }
  rmSync(DAEMON_FILE, { force: true });
  return action;
}

/** What the recorded daemon (if any) currently is, so callers can decide whether
 *  to reuse it, clear a stale record, or replace a wedged (alive-but-unhealthy)
 *  process. Injectable probes keep this pure and unit-testable. */
export type ExistingState = 'healthy' | 'stale' | 'wedged' | 'none';
export async function classifyExisting(
  record: DaemonRecord | null,
  aliveFn: (pid: number) => boolean,
  healthyFn: (port: number) => Promise<boolean>,
): Promise<ExistingState> {
  if (!record) return 'none';
  if (!aliveFn(record.pid)) return 'stale';
  return (await healthyFn(record.port)) ? 'healthy' : 'wedged';
}

/**
 * Decide what to do with an alive-but-unhealthy (`wedged`) record, given an
 * ownership verdict from {@link daemonOwnsPid}. Shared by `ensureDaemon` and the
 * CLI's `start` so the two can't drift on something this consequential.
 *
 * - `replace` — it is our hung daemon: SIGTERM it and spawn a new one.
 * - `discard` — the PID was recycled and belongs to someone else: the record is
 *   stale, so drop it and spawn WITHOUT signalling anything.
 * - `refuse`  — ownership is unknown; do not signal, surface `message`.
 */
export type WedgeAction =
  | { kind: 'replace' }
  | { kind: 'discard'; message: string }
  | { kind: 'refuse'; message: string };

export function planWedgeAction(record: DaemonRecord, owned: boolean | 'unknown'): WedgeAction {
  if (owned === true) return { kind: 'replace' };
  if (owned === false) {
    return {
      kind: 'discard',
      message:
        `pid ${record.pid} in daemon.json is not a claudescope process — the PID was ` +
        'reused after a crash. Discarding the stale record without signalling it.',
    };
  }
  return {
    kind: 'refuse',
    message:
      `could not verify that pid ${record.pid} is the claudescope daemon, so it was ` +
      'NOT signalled. Check it yourself and, if it is ours, stop it manually:\n' +
      `  ps -p ${record.pid} -o args=\n` +
      `  kill ${record.pid}`,
  };
}

/** Roll the daemon log to `.1` once it exceeds {@link LOG_MAX_BYTES}. Best-effort. */
export function rotateLogIfLarge(): void {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      rmSync(`${LOG_FILE}.1`, { force: true });
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {
    /* non-fatal: logging is best-effort */
  }
}

/** Spawn the server detached (stdio → daemon log). Fire-and-forget: callers wait
 *  for health themselves. The spawned server writes daemon.json itself once it
 *  holds the port (CLAUDESCOPE_DAEMON=1 → {@link writeDaemonRecord}), so a spawn
 *  that loses a concurrent race for the port never leaves a record behind
 *  claiming the PID that is about to die with EADDRINUSE. */
export function spawnDaemon(port: number): void {
  ensureStateDir();
  rotateLogIfLarge();
  const logFd = openSync(LOG_FILE, 'a', STATE_FILE_MODE);
  // Detached + stdio→log + unref: the server keeps running after this CLI exits.
  // OPEN_BROWSER=0 so the daemon never opens a browser; the CLI owns that.
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(port), OPEN_BROWSER: '0', CLAUDESCOPE_DAEMON: '1' },
  });
  child.unref();
}

/** Write daemon.json, atomically and owner-only. Called by the server after a
 *  successful bind, so the record always names the process that holds the port. */
export function writeDaemonRecord(port: number, pid: number = process.pid): void {
  ensureStateDir();
  const record: DaemonRecord = {
    pid,
    port,
    url: `http://localhost:${port}`,
    version: APP_VERSION,
    startedAt: new Date().toISOString(),
  };
  const tmp = `${DAEMON_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: STATE_FILE_MODE });
  renameSync(tmp, DAEMON_FILE);
}

/** A running daemon's address, as ensured by {@link ensureDaemon}. */
export interface EnsuredDaemon {
  port: number;
  url: string;
}

/** Injectable process/network probes for {@link ensureDaemon}, following the
 *  {@link classifyExisting} pattern — tests never spawn or kill anything. */
export interface DaemonProbes {
  alive: (pid: number) => boolean;
  /** Confirms a live PID is really our daemon before we signal it. */
  owns: (pid: number) => boolean | 'unknown';
  healthy: (port: number) => Promise<boolean>;
  health: (port: number) => Promise<HealthResponse | null>;
  terminate: (
    record: DaemonRecord,
    owns?: (pid: number) => boolean | 'unknown',
  ) => Promise<WedgeAction>;
  spawn: (port: number) => void;
  waitHealthy: (port: number, timeoutMs: number) => Promise<boolean>;
}

const realProbes: DaemonProbes = {
  alive: isAlive,
  owns: daemonOwnsPid,
  healthy: isHealthy,
  health: fetchDaemonHealth,
  terminate: terminateDaemon,
  spawn: spawnDaemon,
  waitHealthy: waitForHealth,
};

/**
 * Make sure a daemon of THIS package version is running and return its address
 * — the MCP server (and the query subcommands) call this before proxying.
 * Adopts a healthy daemon; when its version differs from this CLI's, terminates
 * it (ownership-gated, like every other signal) and spawns the current install
 * instead — unless CLAUDESCOPE_AUTO_RESTART=0, or ownership cannot be verified,
 * both of which warn and adopt. Clears a stale record, replaces a wedged
 * process, and spawns a fresh server otherwise. All progress goes to `log`
 * (stderr by default); throws with a user-actionable message when a daemon
 * can't be had.
 */
export async function ensureDaemon(
  log: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
  probes: Partial<DaemonProbes> = {},
): Promise<EnsuredDaemon> {
  const p = { ...realProbes, ...probes };
  const existing = readDaemon();
  const state = await classifyExisting(existing, p.alive, p.healthy);
  if (state === 'healthy' && existing) {
    const runningVersion = (await p.health(existing.port))?.version;
    const skewed = runningVersion !== undefined && runningVersion !== APP_VERSION;
    if (!skewed) return { port: existing.port, url: existing.url };
    if (!autoRestartEnabled()) {
      log(
        `⚠ running claudescope daemon is v${runningVersion}, this CLI is v${APP_VERSION} — ` +
          'run `claudescope restart` to align them',
      );
      return { port: existing.port, url: existing.url };
    }
    log(
      `claudescope daemon is v${runningVersion}, this CLI is v${APP_VERSION} — restarting it…`,
    );
    const action = await p.terminate(existing);
    if (action.kind === 'refuse') {
      // Safe to use, not safe to kill: it just answered /api/health, and failing
      // here would break every MCP/query call on a machine without `ps`.
      log(`⚠ ${action.message}`);
      log('adopting the running daemon without aligning versions');
      return { port: existing.port, url: existing.url };
    }
    // A `discard` means the PID was recycled: nothing was signalled and the
    // record is gone. Either way, fall through to the spawn below.
    if (action.kind === 'discard') log(action.message);
  }
  if (state === 'stale') rmSync(DAEMON_FILE, { force: true });
  if (state === 'wedged' && existing) {
    // Same replace semantics as `claudescope start`: SIGTERM and wait, rather
    // than spawning a second server that would fail to bind — but only once the
    // PID is confirmed ours (see planWedgeAction).
    const action = planWedgeAction(existing, p.owns(existing.pid));
    if (action.kind === 'refuse') throw new Error(action.message);
    if (action.kind === 'discard') {
      log(action.message);
      rmSync(DAEMON_FILE, { force: true });
    } else {
      log(`claudescope daemon (pid ${existing.pid}) is unresponsive; replacing it…`);
      await p.terminate(existing, () => true);
    }
  }

  // Respawn a healed (healthy-but-skewed) daemon on its original port — a
  // user-chosen --port must survive an MCP/query heal. Fresh spawns default.
  const port = state === 'healthy' && existing ? existing.port : DEFAULT_PORT;
  log(`starting claudescope daemon on port ${port}…`);
  p.spawn(port);
  if (!(await p.waitHealthy(port, 30_000))) {
    throw new Error('claudescope daemon did not become healthy in time; inspect: claudescope logs');
  }
  return { port, url: `http://localhost:${port}` };
}
