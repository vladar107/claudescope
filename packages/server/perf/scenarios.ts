/**
 * Perf scenarios over the real server hot paths. Imported dynamically by run.ts
 * AFTER the temp env vars are set, so the transitive server imports (config,
 * duckdb, index) bind to the throwaway database.
 *
 * Fast operations are measured in BATCHES (one sample = N timed iterations) so
 * every gated sample lands well above shared-runner jitter — a 2ms no-op
 * reindex is unmeasurable on a noisy VM, but 50 of them (~100-200ms) are not.
 * Raw samples are kept on each metric for the comparator's statistical gate.
 */

import { rmSync, utimesSync } from 'node:fs';
import Fastify from 'fastify';
import { DUCKDB_PATH } from '../src/config.js';
import { closeConnection } from '../src/db/duckdb.js';
import { reindex } from '../src/data/index.js';
import { loadSessionData } from '../src/data/session-loader.js';
import { assembleThread, buildSubagentRuns } from '../src/data/parser.js';
import { registerRoutes } from '../src/routes/index.js';
import type { CorpusInfo } from './fixtures.js';
import type { Metric } from './types.js';
import { median, percentile } from './stats.js';

// Iterations per batch sample, sized so one batch ≈ 100ms+ even on fast runs.
const NOOP_ITERS = 50;
const SINGLE_FILE_ITERS = 10;
const SEARCH_ITERS = 25;
const ANALYTICS_ITERS = 10;
const SESSION_LOAD_ITERS = 3;

const metric = (
  id: string,
  label: string,
  unit: string,
  samples: number[],
  headline: boolean,
  betterIsLower: boolean,
  itersPerSample = 1,
): Metric => ({
  id,
  label,
  unit,
  value: median(samples),
  headline,
  betterIsLower,
  samples,
  itersPerSample,
});

async function timeit(fn: () => Promise<unknown> | unknown): Promise<number> {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6; // ms
}

async function samples(fn: () => Promise<unknown> | unknown, runs: number, warmup = 1): Promise<number[]> {
  for (let i = 0; i < warmup; i++) await fn();
  const out: number[] = [];
  for (let i = 0; i < runs; i++) out.push(await timeit(fn));
  return out;
}

/** One sample = `iters` timed iterations of `fn`; 2 warmup batches (JIT + caches). */
async function batchedSamples(
  fn: () => Promise<unknown> | unknown,
  iters: number,
  runs: number,
): Promise<number[]> {
  const batch = async () => {
    for (let i = 0; i < iters; i++) await fn();
  };
  return samples(batch, runs, 2);
}

function discardDb(): void {
  for (const suffix of ['', '.wal', '.tmp']) {
    rmSync(`${DUCKDB_PATH}${suffix}`, { force: true, recursive: true });
  }
}

export async function runAllScenarios(
  info: CorpusInfo,
  opts: { runs: number },
): Promise<Metric[]> {
  const { runs } = opts;
  const metrics: Metric[] = [];

  // 1. Cold full index build — discard DB + rebuild each sample. Leaves a built
  //    index for the warm scenarios below. One build is seconds long at CI
  //    scale, so each build is its own (unbatched) sample.
  const coldFn = async () => {
    await closeConnection();
    discardDb();
    await reindex();
  };
  const cold = await samples(coldFn, runs);
  metrics.push(
    metric('cold_index.events_per_sec', 'Cold index throughput', 'events/s', cold.map((ms) => info.totalEvents / (ms / 1000)), true, false),
  );
  metrics.push(
    metric('cold_index.mb_per_sec', 'Cold index throughput', 'MB/s', cold.map((ms) => info.totalBytes / 1e6 / (ms / 1000)), false, false),
  );
  metrics.push(metric('cold_index.wall_ms', 'Cold index build', 'ms', cold, false, true));

  // 2. No-op reindex — nothing changed on disk; must stay cheap (runs every 15s).
  const noop = await batchedSamples(() => reindex(), NOOP_ITERS, runs);
  metrics.push(
    metric('noop_reindex.batch_ms', `No-op reindex ×${NOOP_ITERS}`, 'ms', noop, true, true, NOOP_ITERS),
  );

  // 3. Single-file-change reindex — bump one session file's mtime, reindex.
  const oneFile = await batchedSamples(async () => {
    const now = new Date();
    utimesSync(info.largeSessionFile, now, now);
    await reindex();
  }, SINGLE_FILE_ITERS, runs);
  metrics.push(
    metric('single_file_reindex.batch_ms', `Single-file reindex ×${SINGLE_FILE_ITERS}`, 'ms', oneFile, false, true, SINGLE_FILE_ITERS),
  );

  // Build the app for route-level scenarios (faithful to production queries).
  const app = Fastify();
  await registerRoutes(app);
  await app.ready();
  try {
    // 4. Search (BM25 FTS) — batched for the gate, plus a short unbatched pass
    //    so per-call p50/p95 stay visible (informational: a p95 over a handful
    //    of ~15ms calls is structurally jitter and must never gate).
    const searchUrl = `/api/search?q=${encodeURIComponent(info.searchTerm)}`;
    const searchCall = () => app.inject({ method: 'GET', url: searchUrl });
    const search = await batchedSamples(searchCall, SEARCH_ITERS, runs);
    metrics.push(
      metric('search.batch_ms', `Search BM25 ×${SEARCH_ITERS}`, 'ms', search, true, true, SEARCH_ITERS),
    );
    const searchSingles = await samples(searchCall, Math.max(runs, 10));
    metrics.push(metric('search.p95_ms', 'Search BM25 p95', 'ms', [percentile(searchSingles, 95)], false, true));
    metrics.push(metric('search.p50_ms', 'Search BM25 p50', 'ms', [median(searchSingles)], false, true));

    // 5. Analytics aggregations.
    for (const groupBy of ['day', 'project', 'model'] as const) {
      const a = await batchedSamples(
        () => app.inject({ method: 'GET', url: `/api/analytics?groupBy=${groupBy}` }),
        ANALYTICS_ITERS,
        runs,
      );
      metrics.push(
        metric(`analytics.${groupBy}_batch_ms`, `Analytics (${groupBy}) ×${ANALYTICS_ITERS}`, 'ms', a, false, true, ANALYTICS_ITERS),
      );
    }
  } finally {
    await app.close();
  }

  // 6. Session detail load + thread/subagent assembly on the large session.
  const load = await batchedSamples(async () => {
    const data = await loadSessionData(info.largeSessionId);
    const thread = assembleThread(data.mainEvents);
    buildSubagentRuns(thread, data.subagents);
  }, SESSION_LOAD_ITERS, runs);
  metrics.push(
    metric('session_load.batch_ms', `Session load + assemble ×${SESSION_LOAD_ITERS}`, 'ms', load, false, true, SESSION_LOAD_ITERS),
  );

  return metrics;
}
