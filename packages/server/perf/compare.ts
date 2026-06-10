/**
 * Compare pooled perf samples (base vs candidate) and gate on a statistically
 * significant regression of the HEADLINE metrics.
 *
 * Accepts multiple result files per side — one per interleaved CI round, so
 * temporal runner drift hits both arms alike and cancels in the pooled test:
 *
 *   npm run bench:compare -- --base b1.json --base b2.json \
 *     --candidate c1.json --candidate c2.json [--threshold 10]
 *
 * A headline metric FAILS only when ALL hold:
 *   1. the pooled candidate median regresses more than the threshold,
 *   2. a one-sided Mann-Whitney U test confirms the shift (p < 0.01),
 *   3. the metric is above the significance floor.
 * A noisy baseline (CV > 12%) demotes FAIL to "inconclusive" — visible in the
 * summary, but it does not fail the build on a pathological runner day.
 *
 * Bootstrap: with no base files (e.g. `main` predates the suite) there is
 * nothing to compare — print a notice and exit 0. Base files without raw
 * samples (schema v1) can't back a statistical gate, so the comparison is
 * rendered advisory-only and also exits 0.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { BenchResult, Metric } from './types.js';
import { cv, iqr, mannWhitneyGreater, median } from './stats.js';

const { values } = parseArgs({
  options: {
    base: { type: 'string', multiple: true },
    candidate: { type: 'string', multiple: true },
    threshold: { type: 'string', default: '10' },
    'min-ms': { type: 'string', default: '25' },
  },
});

const threshold = Math.max(0, Number(values.threshold));
// Significance floor: a latency metric is too small to gate on a relative %
// once it's down in the noise (GC/JIT/IO jitter dwarfs the signal). Below this
// it's reported but never fails — a regression that actually matters pushes the
// value above the floor anyway. Batched sampling keeps headline metrics above it.
const minMs = Math.max(0, Number(values['min-ms']));
// One-sided Mann-Whitney significance level for the gate.
const ALPHA = 0.01;
// Pooled-baseline CV above which a regression verdict is only "inconclusive".
const MAX_BASE_CV = 0.12;

function load(paths: string[] | undefined): BenchResult[] {
  const out: BenchResult[] = [];
  for (const path of paths ?? []) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as BenchResult;
      if (parsed.metrics?.length) out.push(parsed);
    } catch {
      /* unreadable file — treat as absent */
    }
  }
  return out;
}

const baseFiles = load(values.base);
const candFiles = load(values.candidate);

/** Append markdown to the GitHub Actions job summary, if running in CI. */
function writeJobSummary(md: string): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, md + '\n');
}

if (candFiles.length === 0) {
  console.error('✗ No candidate results to compare. Did the bench run produce result files?');
  process.exit(1);
}
if (baseFiles.length === 0) {
  const msg = 'No baseline to compare against (bootstrap) — regression gate skipped.';
  console.log(`ℹ ${msg}`);
  writeJobSummary(`## ⚡ Performance\n\nℹ️ ${msg}`);
  process.exit(0);
}

// Schema-v1 base files carry a single aggregated value and no raw samples —
// a statistical gate is impossible, so render the table advisory-only.
const advisory = baseFiles.some((f) => f.meta.schemaVersion === undefined);

/** Pool each side's raw samples per metric id (v1 metrics fall back to [value]). */
function pool(files: BenchResult[]): Map<string, { metric: Metric; samples: number[] }> {
  const out = new Map<string, { metric: Metric; samples: number[] }>();
  for (const file of files) {
    for (const m of file.metrics) {
      const entry = out.get(m.id) ?? { metric: m, samples: [] };
      entry.samples.push(...(m.samples?.length ? m.samples : [m.value]));
      out.set(m.id, entry);
    }
  }
  return out;
}

const basePool = pool(baseFiles);
const candPool = pool(candFiles);

interface Row {
  metric: Metric;
  baseMed: number;
  baseIqr: number;
  candMed: number;
  candIqr: number;
  /** Signed regression %: positive = candidate is worse than base. */
  reg: number;
  /** One-sided M-W p-value that the candidate is worse. */
  p: number;
  baseCv: number;
  belowFloor: boolean;
  verdict: 'FAIL' | 'inconclusive' | 'ok';
}

const rows: Row[] = [];
let failed = false;
for (const [id, cand] of candPool) {
  const base = basePool.get(id);
  if (!base) continue;
  const m = cand.metric;
  const baseMed = median(base.samples);
  const candMed = median(cand.samples);
  const deltaPct = baseMed === 0 ? 0 : ((candMed - baseMed) / baseMed) * 100;
  const reg = m.betterIsLower ? deltaPct : -deltaPct;
  // Direction of "worse": larger for latency, smaller for throughput.
  const p = m.betterIsLower
    ? mannWhitneyGreater(base.samples, cand.samples)
    : mannWhitneyGreater(cand.samples, base.samples);
  const baseCv = cv(base.samples);
  const belowFloor = m.unit === 'ms' && Math.max(baseMed, candMed) < minMs;
  const significant = m.headline && reg > threshold && p < ALPHA && !belowFloor && !advisory;
  let verdict: Row['verdict'] = 'ok';
  if (significant) {
    verdict = baseCv > MAX_BASE_CV ? 'inconclusive' : 'FAIL';
    if (verdict === 'FAIL') failed = true;
  }
  rows.push({
    metric: m,
    baseMed,
    baseIqr: iqr(base.samples),
    candMed,
    candIqr: iqr(cand.samples),
    reg,
    p,
    baseCv,
    belowFloor,
    verdict,
  });
}

// --- console (CI logs) ------------------------------------------------------
console.log(
  `Perf comparison (gate: headline Δ > ${threshold}% AND p < ${ALPHA}; * = headline; ` +
    `${baseFiles.length} base / ${candFiles.length} candidate file(s))${advisory ? ' — ADVISORY (v1 base)' : ''}:\n`,
);
for (const r of rows) {
  const sign = r.reg >= 0 ? '+' : '';
  console.log(
    `  ${r.metric.headline ? '*' : ' '} ${r.metric.id.padEnd(30)} base=${r.baseMed
      .toFixed(2)
      .padStart(10)}  cand=${r.candMed.toFixed(2).padStart(10)}  ${(sign + r.reg.toFixed(1) + '%').padStart(9)}  p=${r.p
      .toFixed(3)
      .padStart(5)}  ${r.verdict}`,
  );
}

// --- GitHub Actions job summary --------------------------------------------
function fmtValue(unit: string, value: number): string {
  if (unit === 'events/s') return Math.round(value).toLocaleString('en-US');
  return value.toFixed(2);
}
function fmtCell(unit: string, med: number, spread: number): string {
  return `${fmtValue(unit, med)} ±${fmtValue(unit, spread)}`;
}
function deltaCell(reg: number): string {
  const arrow = Math.abs(reg) < 0.05 ? '■' : reg > 0 ? '▲' : '▼';
  return `${arrow} ${reg >= 0 ? '+' : '-'}${Math.abs(reg).toFixed(1)}%`;
}
function verdictIcon(r: Row): string {
  if (r.verdict === 'FAIL') return '⚠️';
  if (r.verdict === 'inconclusive') return '❓';
  if (r.belowFloor) return '💤';
  return r.reg < -5 ? '🚀' : '✅';
}
function mdTable(subset: Row[]): string {
  const head =
    '| Metric | Baseline | This PR | Δ vs base | p | base CV |    |\n|---|--:|--:|--:|--:|--:|:--:|';
  const body = subset
    .map(
      (r) =>
        `| ${r.metric.label} (${r.metric.unit}) | ${fmtCell(r.metric.unit, r.baseMed, r.baseIqr)} | ${fmtCell(
          r.metric.unit,
          r.candMed,
          r.candIqr,
        )} | ${deltaCell(r.reg)} | ${r.p.toFixed(3)} | ${(r.baseCv * 100).toFixed(1)}% | ${verdictIcon(r)} |`,
    )
    .join('\n');
  return `${head}\n${body}`;
}

const headline = rows.filter((r) => r.metric.headline);
const m = candFiles[0].meta;
const banner = advisory
  ? '## ⚡ Performance: ℹ️ advisory only (baseline lacks per-sample data)'
  : failed
    ? `## ⚡ Performance: ⚠️ significant headline regression > ${threshold}%`
    : '## ⚡ Performance: ✅ no significant headline regression';
const summary = [
  banner,
  '',
  `baseline (\`main\`) vs candidate (PR), ${baseFiles.length}+${candFiles.length} interleaved runs pooled · ` +
    `gate Δ > ${threshold}% AND Mann-Whitney p < ${ALPHA} on headline · floor ${minMs} ms`,
  '',
  '### Key metrics',
  '',
  headline.length ? mdTable(headline) : '_No headline metrics._',
  '',
  `<details><summary>All metrics (${rows.length})</summary>\n`,
  mdTable(rows),
  '\n</details>',
  '',
  `<sub>Values are pooled median ±IQR. Δ vs base: ▲ positive = slower/worse, ▼ = faster. ` +
    `✅ within gate · ⚠️ significant regression · ❓ regression but baseline too noisy (CV > ${MAX_BASE_CV * 100}%) · ` +
    `💤 below ${minMs} ms floor · 🚀 >5% faster. ` +
    `Corpus: ${m.totalEvents.toLocaleString('en-US')} events · ${(m.totalBytes / 1e6).toFixed(1)} MB · scale ${m.scale} · runs ${m.runs}/file.</sub>`,
].join('\n');
writeJobSummary(summary);

if (failed) {
  console.error(
    `\n✗ Performance regression: a headline metric regressed more than ${threshold}% with p < ${ALPHA}.`,
  );
  process.exit(1);
}
console.log(advisory ? '\nℹ Advisory comparison only (no gate).' : '\n✓ No significant headline regression.');
process.exit(0);
