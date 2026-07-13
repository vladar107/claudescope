/**
 * Daemon lifecycle primitives, shared by the user-facing CLI commands
 * (`start`/`stop`/`status`/… in cli.ts) and the MCP server (`claudescope mcp`),
 * which must silently ensure a daemon is running before it can proxy queries.
 *
 * The daemon is one detached server process tracked by `daemon.json` in the
 * state dir. Everything here writes progress to callbacks or stderr — never to
 * stdout, which an MCP stdio server owns as its protocol channel.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthResponse } from '@claudescope/shared';
import { APP_VERSION, CLAUDESCOPE_HOME, PORT as DEFAULT_PORT, autoRestartEnabled } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The server bundle, a sibling of the CLI in the published package. */
export const SERVER_ENTRY = join(__dirname, 'server.js');
export const DAEMON_FILE = join(CLAUDESCOPE_HOME, 'daemon.json');
export const LOG_FILE = join(CLAUDESCOPE_HOME, 'daemon.log');
/** Roll the append-only daemon log once it grows past this, so a long-lived or
 *  crash-looping daemon doesn't grow the log without bound. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;
/** How long to wait for a signalled process to actually exit before giving up. */
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

/** SIGTERM the recorded daemon, wait for it to actually exit, and clear
 *  daemon.json (so a follow-up spawn can rebind the port). Throws with a
 *  kill -9 hint when the process refuses to die within {@link EXIT_WAIT_MS}. */
export async function terminateDaemon(record: DaemonRecord): Promise<void> {
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

/** Spawn the server detached (stdio → daemon log) and record it in daemon.json.
 *  Fire-and-forget: callers wait for health themselves. */
export function spawnDaemon(port: number): void {
  mkdirSync(CLAUDESCOPE_HOME, { recursive: true });
  rotateLogIfLarge();
  const logFd = openSync(LOG_FILE, 'a');
  // Detached + stdio→log + unref: the server keeps running after this CLI exits.
  // OPEN_BROWSER=0 so the daemon never opens a browser; the CLI owns that.
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(port), OPEN_BROWSER: '0' },
  });
  child.unref();

  writeFileSync(
    DAEMON_FILE,
    JSON.stringify(
      {
        pid: child.pid,
        port,
        url: `http://localhost:${port}`,
        version: APP_VERSION,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
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
  healthy: (port: number) => Promise<boolean>;
  health: (port: number) => Promise<HealthResponse | null>;
  terminate: (record: DaemonRecord) => Promise<void>;
  spawn: (port: number) => void;
  waitHealthy: (port: number, timeoutMs: number) => Promise<boolean>;
}

const realProbes: DaemonProbes = {
  alive: isAlive,
  healthy: isHealthy,
  health: fetchDaemonHealth,
  terminate: terminateDaemon,
  spawn: spawnDaemon,
  waitHealthy: waitForHealth,
};

/**
 * Make sure a daemon of THIS package version is running and return its address
 * — the MCP server (and the query subcommands) call this before proxying.
 * Adopts a healthy daemon; when its version differs from this CLI's, restarts
 * it into the current install (unless CLAUDESCOPE_AUTO_RESTART=0, which keeps
 * the old warn-and-adopt behavior). Clears a stale record, replaces a wedged
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
    await p.terminate(existing);
    // Fall through to the spawn below, which starts the current version.
  }
  if (state === 'stale') rmSync(DAEMON_FILE, { force: true });
  if (state === 'wedged' && existing) {
    // Same replace semantics as `claudescope start`: SIGTERM and wait, rather
    // than spawning a second server that would fail to bind.
    log(`claudescope daemon (pid ${existing.pid}) is unresponsive; replacing it…`);
    await p.terminate(existing);
  }

  const port = DEFAULT_PORT;
  log(`starting claudescope daemon on port ${port}…`);
  p.spawn(port);
  if (!(await p.waitHealthy(port, 30_000))) {
    throw new Error('claudescope daemon did not become healthy in time; inspect: claudescope logs');
  }
  return { port, url: `http://localhost:${port}` };
}
