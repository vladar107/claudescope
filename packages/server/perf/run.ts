/**
 * Perf harness entry point. Generates a deterministic synthetic corpus into a
 * throwaway temp dir, runs the hot-path scenarios (warmup + median-of-N), and
 * writes a result JSON + prints a human table.
 *
 *   npm run bench -- --out result.json [--scale 1] [--runs 5] [--round N]
 *
 * Env vars are set BEFORE importing any server module (config binds the DB path
 * at import time), mirroring test/api.integration.test.ts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { generateCorpus } from './fixtures.js';
import type { BenchResult, Metric } from './types.js';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'perf-result.json' },
    scale: { type: 'string', default: '1' },
    runs: { type: 'string', default: '5' },
    // Interleaved CI round number — recorded in result meta only.
    round: { type: 'string' },
  },
});

const scale = Math.max(1, Number(values.scale));
const runs = Math.max(1, Number(values.runs));
const round = values.round !== undefined ? Number(values.round) : undefined;
const outPath = resolve(String(values.out));

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-perf-'));
const projectsDir = join(work, 'projects');
process.env.CLAUDE_PROJECTS_DIR = projectsDir;
// Isolate from any real ~/.codex so the bench corpus is exactly what we generate.
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';
mkdirSync(projectsDir, { recursive: true });
mkdirSync(process.env.CLAUDESCOPE_HOME, { recursive: true });

function table(metrics: Metric[]): string {
  const rows = metrics.map((m) => ({
    name: m.id + (m.headline ? ' *' : ''),
    value: m.value >= 100 ? m.value.toFixed(0) : m.value.toFixed(2),
    unit: m.unit,
  }));
  const w = Math.max(...rows.map((r) => r.name.length), 8);
  const vw = Math.max(...rows.map((r) => r.value.length), 5);
  const lines = rows.map((r) => `  ${r.name.padEnd(w)}  ${r.value.padStart(vw)}  ${r.unit}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const info = generateCorpus(projectsDir, {
    projects: 4,
    sessionsPerProject: 12 * scale,
    eventsPerSession: 60 * scale,
    largeSessions: 2,
    largeSessionEvents: 3000 * scale,
    toolRatio: 0.4,
    thinkingRatio: 0.5,
    seed: 1234,
  });

  // Import scenarios (and thus the server) only now that env is set.
  const { runAllScenarios } = await import('./scenarios.js');
  const { closeConnection } = await import('../src/db/duckdb.js');

  console.log(
    `› corpus: ${info.totalEvents} events, ${(info.totalBytes / 1e6).toFixed(1)} MB (scale ${scale}, runs ${runs})`,
  );
  const metrics = await runAllScenarios(info, { runs });
  await closeConnection();

  const result: BenchResult = {
    meta: {
      schemaVersion: 2,
      timestamp: new Date().toISOString(),
      node: process.version,
      scale,
      runs,
      ...(round !== undefined ? { round } : {}),
      totalEvents: info.totalEvents,
      totalBytes: info.totalBytes,
    },
    metrics,
  };
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');

  console.log(`\nResults (* = headline / CI-gated):\n${table(metrics)}`);
  console.log(`\n› wrote ${outPath}`);
}

main()
  .then(() => {
    rmSync(work, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    rmSync(work, { recursive: true, force: true });
    process.exit(1);
  });
