/**
 * Indexer lifecycle: owns the auto-reindex poller and the runtime pause state.
 *
 * "Stop / Start / Restart" in the web UI control THIS — the background indexing
 * engine — never the HTTP server (which stays terminal-only via `claudescope
 * stop`). Pausing disarms the poller; the index stays fully queryable as a
 * frozen snapshot, and an in-flight pass always drains (passes are
 * uninterruptible by design). The pause flag is runtime-only — deliberately
 * not persisted — so a fresh process always starts indexing.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { IndexerStatus, ReindexResponse } from '@claudescope/shared';
import {
  getLastPass,
  getLastPassAt,
  isIndexReady,
  isRebuildInFlight,
  isReindexInFlight,
  reindex,
} from './data/index.js';
import { reindexIntervalMs } from './settings.js';

let timer: NodeJS.Timeout | null = null;
let paused = false;
let log: FastifyBaseLogger | Console = console;

function disarmTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** (Re-)arm the poller from the CURRENT effective interval. No-op while paused
 *  or when the interval is 0 (auto-reindex disabled). */
export function rearmTimer(): void {
  disarmTimer();
  // Clamp defensively: Node treats setInterval delays over 2^31-1 as 1ms
  // (validation rejects such values, but an env var can still carry one).
  const interval = Math.min(reindexIntervalMs(), 2_147_483_647);
  if (paused || interval <= 0) return;
  timer = setInterval(() => {
    reindex()
      .then((res) => {
        // Failures are reported, not swallowed: a pass that could load nothing
        // returns reindexed: 0 and would otherwise be silent, so the index could
        // stop advancing indefinitely with no signal anywhere.
        if (res.failed > 0) {
          log.warn(
            { reindexed: res.reindexed, failed: res.failed, durationMs: res.durationMs },
            'auto-reindex could not load some files — the index is stale for them',
          );
        } else if (res.reindexed > 0) {
          log.info(
            { reindexed: res.reindexed, durationMs: res.durationMs },
            'auto-reindex picked up changes',
          );
        }
      })
      // A background poll failing is non-fatal — the server keeps serving the
      // existing index — so warn rather than error (avoids error-level spam
      // every interval when, e.g., a single file is briefly unreadable).
      .catch((err) => log.warn({ err }, 'auto-reindex failed'));
  }, interval);
  timer.unref(); // don't keep the process alive solely for the timer
}

/** Boot: kick the initial (incremental) build in the background so the server
 *  accepts connections immediately, then arm the poller. */
export function startIndexer(logger: FastifyBaseLogger): void {
  log = logger;
  reindex()
    .then((res) =>
      log.info(
        { reindexed: res.reindexed, failed: res.failed, durationMs: res.durationMs },
        'initial index build complete',
      ),
    )
    .catch((err) => log.error({ err }, 'initial index build failed'));
  rearmTimer();
}

/** Shutdown hook: stop the poller (in-flight passes drain on their own). */
export function stopIndexerTimer(): void {
  disarmTimer();
}

export function getIndexerStatus(): IndexerStatus {
  const state = !isIndexReady()
    ? 'building'
    : isReindexInFlight()
      ? 'indexing'
      : paused
        ? 'paused'
        : 'watching';
  return {
    state,
    paused,
    intervalMs: reindexIntervalMs(),
    lastPassAt: getLastPassAt(),
    lastPass: getLastPass(),
    rebuilding: isRebuildInFlight(),
  };
}

/**
 * Guarantee a pass STARTS after this call. A pass already in flight may have
 * run discovery with pre-change settings, so joining it is not enough — drain
 * it, then run one more. This is what makes "save new source dir → sessions
 * appear" deterministic instead of next-poll-lucky.
 */
export async function requestPass(): Promise<ReindexResponse> {
  if (isReindexInFlight()) await reindex().catch(() => {});
  return reindex();
}

/** Stop auto-indexing (the UI's Stop). Takes effect after any in-flight pass. */
export function pauseIndexing(): IndexerStatus {
  paused = true;
  disarmTimer();
  return getIndexerStatus();
}

/** Resume auto-indexing (the UI's Start) and kick an immediate pass. */
export async function resumeIndexing(): Promise<IndexerStatus> {
  paused = false;
  rearmTimer();
  if (isIndexReady()) {
    await requestPass();
  } else {
    // Initial build still running — it IS the immediate pass; don't block the
    // response on a potentially long build.
    void reindex().catch(() => {});
  }
  return getIndexerStatus();
}

/** Restart indexing: clear pause, run a fresh pass now, re-arm the poller. */
export async function restartIndexing(): Promise<IndexerStatus> {
  paused = false;
  disarmTimer();
  try {
    if (isIndexReady()) await requestPass();
    else void reindex().catch(() => {});
  } finally {
    rearmTimer();
  }
  return getIndexerStatus();
}

/** Test seam: reset runtime state between suites. */
export function resetIndexerLifecycle(): void {
  disarmTimer();
  paused = false;
  log = console;
}
