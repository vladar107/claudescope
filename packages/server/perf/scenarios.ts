/**
 * Perf scenarios over the real server hot paths. Imported dynamically by run.ts
 * AFTER the temp env vars are set, so the transitive server imports (config,
 * duckdb, index) bind to the throwaway database.
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

const metric = (
  id: string,
  label: string,
  unit: string,
  value: number,
  headline: boolean,
  betterIsLower: boolean,
): Metric => ({ id, label, unit, value, headline, betterIsLower });

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

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
};

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
  //    index for the warm scenarios below.
  const coldFn = async () => {
    await closeConnection();
    discardDb();
    await reindex();
  };
  const cold = await samples(coldFn, runs);
  const coldMs = median(cold);
  metrics.push(metric('cold_index.events_per_sec', 'Cold index throughput', 'events/s', info.totalEvents / (coldMs / 1000), true, false));
  metrics.push(metric('cold_index.mb_per_sec', 'Cold index throughput', 'MB/s', info.totalBytes / 1e6 / (coldMs / 1000), false, false));
  metrics.push(metric('cold_index.wall_ms', 'Cold index build', 'ms', coldMs, false, true));

  // 2. No-op reindex — nothing changed on disk; must stay cheap (runs every 15s).
  const noop = await samples(() => reindex(), runs);
  metrics.push(metric('noop_reindex.wall_ms', 'No-op reindex', 'ms', median(noop), true, true));

  // 3. Single-file-change reindex — bump one session file's mtime, reindex.
  const oneFile = await samples(async () => {
    const now = new Date();
    utimesSync(info.largeSessionFile, now, now);
    await reindex();
  }, runs);
  metrics.push(metric('single_file_reindex.wall_ms', 'Single-file reindex', 'ms', median(oneFile), false, true));

  // Build the app for route-level scenarios (faithful to production queries).
  const app = Fastify();
  await registerRoutes(app);
  await app.ready();
  try {
    // 4. Search (BM25 FTS).
    const searchUrl = `/api/search?q=${encodeURIComponent(info.searchTerm)}`;
    const search = await samples(() => app.inject({ method: 'GET', url: searchUrl }), Math.max(runs, 10));
    metrics.push(metric('search.p95_ms', 'Search BM25 p95', 'ms', percentile(search, 95), true, true));
    metrics.push(metric('search.p50_ms', 'Search BM25 p50', 'ms', median(search), false, true));

    // 5. Analytics aggregations.
    for (const groupBy of ['day', 'project', 'model'] as const) {
      const a = await samples(() => app.inject({ method: 'GET', url: `/api/analytics?groupBy=${groupBy}` }), runs);
      metrics.push(metric(`analytics.${groupBy}_ms`, `Analytics (${groupBy})`, 'ms', median(a), false, true));
    }
  } finally {
    await app.close();
  }

  // 6. Session detail load + thread/subagent assembly on the large session.
  const load = await samples(async () => {
    const data = await loadSessionData(info.largeSessionId);
    const thread = assembleThread(data.mainEvents);
    buildSubagentRuns(thread, data.subagents);
  }, runs);
  metrics.push(metric('session_load.wall_ms', 'Session load + assemble', 'ms', median(load), false, true));

  return metrics;
}
