/**
 * Graceful shutdown — what a SIGTERM from `claudescope stop`/`restart` (or a
 * Ctrl-C in the foreground) must do before this process dies.
 *
 * Without a handler Node kills the process on the spot, which leaves DuckDB's
 * WAL behind for replay on the next open — and a kill landing between the
 * `PRAGMA create_fts_index` and the CHECKPOINT that follows it (see
 * `rebuildFtsIndex` in data/index.ts) leaves a WAL DuckDB *cannot* replay, so
 * the index is discarded and rebuilt from scratch. Draining the in-flight pass
 * and closing the connection cleanly turns that into a no-op, and lines the
 * signal path up with self-restart.ts, which already refuses to hand off
 * mid-pass.
 */

import type { FastifyInstance } from 'fastify';
import { isReindexInFlight, reindex } from './data/index.js';
import { closeConnection } from './db/duckdb.js';
import { stopIndexerTimer } from './indexer-lifecycle.js';

/**
 * How long shutdown waits for an in-flight index pass to drain.
 *
 * Must stay comfortably under daemon.ts's `EXIT_WAIT_MS` (5000) *including* the
 * Fastify close that follows it: once that budget is spent `terminateDaemon`
 * gives up and reports a hung daemon with a `kill -9` hint, so a drain that
 * outlives it would turn every stop into a scary error message.
 */
export const DRAIN_MS = 3500;

/** Everything the shutdown sequence touches, injected so it can be exercised
 *  without signals, a real server, or a real database. */
export interface ShutdownDeps {
  log(msg: string): void;
  stopTimers(): void;
  /** The running index pass, or null when none is in flight. */
  inFlightPass(): Promise<unknown> | null;
  closeApp(): Promise<void>;
  closeDb(): Promise<void>;
  exit(code: number): void;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run one shutdown step, reporting a failure instead of propagating it: none
 *  of them may keep the process from exiting. */
async function step(deps: ShutdownDeps, what: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    deps.log(`shutdown: ${what} failed — ${describe(err)}`);
  }
}

/** Wait for the pass to finish, up to `drainMs`; the result says whether it
 *  did. A pass that REJECTED counts as finished — what matters is only that
 *  nothing is still running against the connection. */
async function drain(pass: Promise<unknown>, drainMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pass.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), drainMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop accepting work, let an index pass finish, close the HTTP server, and
 * close the index — then exit. Every step is best-effort: one failure logs and
 * moves on, because the process must exit either way (the CLI is waiting).
 */
export async function shutdown(deps: ShutdownDeps, drainMs = DRAIN_MS): Promise<void> {
  deps.log('shutting down — draining');
  await step(deps, 'stopping the indexer', () => deps.stopTimers());

  let pass: Promise<unknown> | null = null;
  try {
    pass = deps.inFlightPass();
  } catch (err) {
    deps.log(`shutdown: could not check for an in-flight index pass — ${describe(err)}`);
  }
  const drained = pass ? await drain(pass, drainMs) : true;

  await step(deps, 'closing the HTTP server', () => deps.closeApp());

  if (drained) {
    // Nothing is running against the connection any more, so DuckDB can
    // checkpoint and drop the WAL — the next open needs no replay.
    await step(deps, 'closing the index', () => deps.closeDb());
  } else {
    deps.log(
      `shutdown: index pass still running after ${drainMs}ms — leaving the index open ` +
        'rather than closing it under a live statement; WAL replay covers it on reopen',
    );
  }

  deps.exit(0);
}

/** Installed handlers: `handler` so tests can drive a signal without raising
 *  one, `uninstall` so they don't leak listeners between suites. */
export interface ShutdownHandle {
  handler: (signal: NodeJS.Signals) => void;
  uninstall: () => void;
}

let installed: ShutdownHandle | null = null;

/**
 * Register the SIGTERM/SIGINT handlers (once per process). The first signal
 * starts {@link shutdown}; a second one during it stops waiting and exits
 * non-zero, so an impatient Ctrl-C still works.
 */
export function installShutdownHandlers(
  app: FastifyInstance,
  overrides: Partial<ShutdownDeps> = {},
): ShutdownHandle {
  if (installed) return installed;

  const deps: ShutdownDeps = {
    log: (msg) => app.log.info(msg),
    // Only the reindex poller is stopped here; the boot-time pricing,
    // update-check and self-restart intervals are cleared by index.ts's
    // `onClose` hooks when app.close() runs below.
    stopTimers: stopIndexerTimer,
    // reindex() hands back the in-flight promise when a pass is running, so
    // this joins that pass instead of starting another one.
    inFlightPass: () => (isReindexInFlight() ? reindex() : null),
    closeApp: () => app.close(),
    closeDb: closeConnection,
    exit: (code) => process.exit(code),
    ...overrides,
  };

  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      deps.log(`${signal} during shutdown — exiting now`);
      deps.exit(1);
      return;
    }
    shuttingDown = true;
    deps.log(`${signal} received`);
    void shutdown(deps);
  };

  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  const handle: ShutdownHandle = {
    handler,
    uninstall: () => {
      process.off('SIGTERM', handler);
      process.off('SIGINT', handler);
      if (installed === handle) installed = null;
    },
  };
  installed = handle;
  return handle;
}
