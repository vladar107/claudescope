/**
 * Graceful-shutdown tests (src/shutdown.ts). The point of the handler is that a
 * `claudescope stop` never kills the process mid-write, so what is pinned here
 * is the ordering that makes that true — stop the poller, let an index pass
 * drain, close the server, close the index — plus the two cases where it must
 * NOT close the index: a pass that outlives the drain budget (closing under a
 * live statement is unsafe), and every failing step still reaching the exit,
 * because the CLI is timing us (daemon.ts EXIT_WAIT_MS).
 *
 * The last case is the observable property the whole path exists for: a clean
 * closeConnection() checkpoints and removes the WAL, so the next open needs no
 * replay — the replay that corrupts a file killed between the FTS index DDL and
 * its CHECKPOINT (data/index.ts).
 *
 * CLAUDESCOPE_HOME / DUCKDB_PATH are set before any server module is imported
 * (config.ts freezes them at import); no real agent source or state dir is
 * touched.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const work = mkdtempSync(join(tmpdir(), 'claudescope-shutdown-'));
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.DUCKDB_PATH = join(work, 'home', 'index.duckdb');
process.env.CLAUDE_PROJECTS_DIR = join(work, 'projects-empty');
process.env.REINDEX_INTERVAL_MS = '0';
process.env.PRICING_REFRESH_INTERVAL_MS = '0';

const { installShutdownHandlers, shutdown } = await import('../src/shutdown.js');
type ShutdownDeps = Parameters<typeof shutdown>[0];

afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Recording deps: every step appends its name to `calls`. */
function makeDeps(over: Partial<ShutdownDeps> = {}): {
  deps: ShutdownDeps;
  calls: string[];
  logs: string[];
} {
  const calls: string[] = [];
  const logs: string[] = [];
  const deps: ShutdownDeps = {
    log: (msg) => void logs.push(msg),
    stopTimers: () => void calls.push('stopTimers'),
    inFlightPass: () => null,
    closeApp: async () => void calls.push('closeApp'),
    closeDb: async () => void calls.push('closeDb'),
    exit: (code) => void calls.push(`exit:${code}`),
    ...over,
  };
  return { deps, calls, logs };
}

const after = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('shutdown', () => {
  it('stops the poller, closes the server, then the index — in that order', async () => {
    const { deps, calls } = makeDeps();
    await shutdown(deps, 50);
    expect(calls).toEqual(['stopTimers', 'closeApp', 'closeDb', 'exit:0']);
  });

  it('waits for an in-flight pass and closes the index once it finished', async () => {
    const { deps, calls } = makeDeps({
      inFlightPass: () => after(20).then(() => void calls.push('pass')),
    });
    await shutdown(deps, 1000);
    expect(calls).toEqual(['stopTimers', 'pass', 'closeApp', 'closeDb', 'exit:0']);
  });

  it('leaves the index open when the pass outlives the drain budget', async () => {
    const { deps, calls, logs } = makeDeps({ inFlightPass: () => after(300) });
    await shutdown(deps, 20);
    expect(calls).toEqual(['stopTimers', 'closeApp', 'exit:0']);
    expect(logs.join('\n')).toMatch(/pass still running/);
  });

  it('still exits when a step throws', async () => {
    const { deps, calls, logs } = makeDeps({
      closeApp: async () => {
        throw new Error('server close blew up');
      },
    });
    await shutdown(deps, 50);
    expect(calls).toEqual(['stopTimers', 'closeDb', 'exit:0']);
    expect(logs.join('\n')).toMatch(/server close blew up/);
  });
});

describe('installShutdownHandlers', () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it('exits immediately on a second signal instead of waiting out the drain', async () => {
    const { deps, calls, logs } = makeDeps({ inFlightPass: () => after(50) });
    const app = { log: { info: deps.log }, close: deps.closeApp } as unknown as FastifyInstance;
    const handle = installShutdownHandlers(app, deps);
    uninstall = handle.uninstall;

    handle.handler('SIGTERM');
    handle.handler('SIGTERM');
    // Synchronous: the impatient second signal must not queue behind the drain.
    expect(calls).toEqual(['stopTimers', 'exit:1']);
    expect(logs.join('\n')).toMatch(/during shutdown/);
  });
});

describe('closeConnection', () => {
  it('leaves no WAL behind, so the next open needs no replay', async () => {
    const dbPath = join(work, 'wal', 'index.duckdb');
    process.env.DUCKDB_PATH = dbPath;
    vi.resetModules();
    const { getConnection, closeConnection } = await import('../src/db/duckdb.js');

    const conn = await getConnection();
    await conn.run('CREATE TABLE wal_probe (i INTEGER, s VARCHAR)');
    await conn.run("INSERT INTO wal_probe SELECT i, repeat('x', 512) FROM range(2000) t(i)");
    expect(existsSync(`${dbPath}.wal`)).toBe(true);

    await closeConnection();
    expect(existsSync(`${dbPath}.wal`)).toBe(false);
  });
});
