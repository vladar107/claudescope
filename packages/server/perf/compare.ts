/**
 * Compare two perf result files (base vs candidate) and gate on regression of
 * the HEADLINE metrics. Used by the same-runner A/B CI job: both files are
 * produced on the same VM moments apart, so most machine variance cancels and a
 * tight-ish threshold is meaningful.
 *
 *   npm run bench:compare -- --base base.json --candidate cand.json [--threshold 10]
 *
 * Bootstrap: if the base file is missing/empty (e.g. `main` predates the suite),
 * there is nothing to compare against — print a notice and exit 0.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { BenchResult, Metric } from './types.js';

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    candidate: { type: 'string' },
    threshold: { type: 'string', default: '10' },
    'min-ms': { type: 'string', default: '25' },
  },
});

const threshold = Math.max(0, Number(values.threshold));
// Significance floor: a latency metric is too small to gate on a relative %
// once it's down in the noise (GC/JIT/IO jitter dwarfs the signal). Below this
// it's reported but never fails — a regression that actually matters pushes the
// value above the floor anyway.
const minMs = Math.max(0, Number(values['min-ms']));

function load(path: string | undefined): BenchResult | null {
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BenchResult;
    if (!parsed.metrics?.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

const base = load(values.base);
const candidate = load(values.candidate);

/** Append markdown to the GitHub Actions job summary, if running in CI. */
function writeJobSummary(md: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, md + '\n');
}

if (!candidate) {
  console.error('✗ No candidate results to compare. Did the bench run produce a result file?');
  process.exit(1);
}
if (!base) {
  const msg = 'No baseline to compare against (bootstrap) — regression gate skipped.';
  console.log(`ℹ ${msg}`);
  writeJobSummary(`## ⚡ Performance\n\nℹ️ ${msg}`);
  process.exit(0);
}

const baseById = new Map<string, Metric>(base.metrics.map((m) => [m.id, m]));

/** Signed regression percentage: positive = candidate is worse (slower) than base. */
function regressionPct(b: Metric, c: Metric): number {
  if (b.value === 0) return 0;
  const deltaPct = ((c.value - b.value) / b.value) * 100;
  return b.betterIsLower ? deltaPct : -deltaPct;
}

interface Row {
  metric: Metric;
  base: number;
  reg: number;
  belowFloor: boolean;
  verdict: 'FAIL' | 'noise' | 'ok';
}

const rows: Row[] = [];
let failed = false;
for (const c of candidate.metrics) {
  const b = baseById.get(c.id);
  if (!b) continue;
  const reg = regressionPct(b, c);
  // Latency metrics below the significance floor are reported, never gated.
  const belowFloor = c.unit === 'ms' && Math.max(b.value, c.value) < minMs;
  const regressed = c.headline && reg > threshold && !belowFloor;
  if (regressed) failed = true;
  const verdict: Row['verdict'] = regressed
    ? 'FAIL'
    : belowFloor && c.headline && reg > threshold
      ? 'noise'
      : 'ok';
  rows.push({ metric: c, base: b.value, reg, belowFloor, verdict });
}

// --- console (CI logs) ------------------------------------------------------
console.log(`Perf comparison (threshold ${threshold}% on headline metrics, * = headline):\n`);
for (const r of rows) {
  const sign = r.reg >= 0 ? '+' : '';
  console.log(
    `  ${r.metric.headline ? '*' : ' '} ${r.metric.id.padEnd(28)} base=${r.base
      .toFixed(2)
      .padStart(10)}  cand=${r.metric.value.toFixed(2).padStart(10)}  ${(sign + r.reg.toFixed(1) + '%').padStart(9)}  ${r.verdict}`,
  );
}

// --- GitHub Actions job summary --------------------------------------------
function fmtValue(unit: string, value: number): string {
  if (unit === 'events/s') return Math.round(value).toLocaleString('en-US');
  return value.toFixed(2);
}
function deltaCell(reg: number): string {
  const arrow = Math.abs(reg) < 0.05 ? '■' : reg > 0 ? '▲' : '▼';
  return `${arrow} ${reg >= 0 ? '+' : '-'}${Math.abs(reg).toFixed(1)}%`;
}
function verdictIcon(r: Row): string {
  if (r.verdict === 'FAIL') return '⚠️';
  if (r.verdict === 'noise') return '💤';
  return r.reg < -5 ? '🚀' : '✅';
}
function mdTable(subset: Row[]): string {
  const head = '| Metric | Baseline | This PR | Δ vs base |    |\n|---|--:|--:|--:|:--:|';
  const body = subset
    .map(
      (r) =>
        `| ${r.metric.label} (${r.metric.unit}) | ${fmtValue(r.metric.unit, r.base)} | ${fmtValue(
          r.metric.unit,
          r.metric.value,
        )} | ${deltaCell(r.reg)} | ${verdictIcon(r)} |`,
    )
    .join('\n');
  return `${head}\n${body}`;
}

const headline = rows.filter((r) => r.metric.headline);
const m = candidate.meta;
const banner = failed
  ? `## ⚡ Performance: ⚠️ headline regression > ${threshold}%`
  : '## ⚡ Performance: ✅ no headline regression';
const summary = [
  banner,
  '',
  `baseline (\`main\`) vs candidate (PR) · gate ${threshold}% on headline · floor ${minMs} ms`,
  '',
  '### Key metrics',
  '',
  headline.length ? mdTable(headline) : '_No headline metrics._',
  '',
  `<details><summary>All metrics (${rows.length})</summary>\n`,
  mdTable(rows),
  '\n</details>',
  '',
  `<sub>Δ vs base: ▲ positive = slower/worse, ▼ = faster. ✅ within gate · ⚠️ regressed · 💤 below ${minMs} ms floor (ignored) · 🚀 >5% faster. Corpus: ${m.totalEvents.toLocaleString('en-US')} events · ${(m.totalBytes / 1e6).toFixed(1)} MB · scale ${m.scale} · runs ${m.runs}.</sub>`,
].join('\n');
writeJobSummary(summary);

if (failed) {
  console.error(`\n✗ Performance regression: a headline metric regressed more than ${threshold}%.`);
  process.exit(1);
}
console.log('\n✓ No headline regression beyond threshold.');
process.exit(0);
