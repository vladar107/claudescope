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

import { readFileSync } from 'node:fs';
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

if (!candidate) {
  console.error('✗ No candidate results to compare. Did the bench run produce a result file?');
  process.exit(1);
}
if (!base) {
  console.log('ℹ No base results to compare against (bootstrap) — skipping the regression gate.');
  process.exit(0);
}

const baseById = new Map<string, Metric>(base.metrics.map((m) => [m.id, m]));

/** Signed regression percentage: positive = candidate is worse than base. */
function regressionPct(b: Metric, c: Metric): number {
  if (b.value === 0) return 0;
  const deltaPct = ((c.value - b.value) / b.value) * 100;
  return b.betterIsLower ? deltaPct : -deltaPct;
}

let failed = false;
const lines: string[] = [];
for (const c of candidate.metrics) {
  const b = baseById.get(c.id);
  if (!b) continue;
  const reg = regressionPct(b, c);
  const flag = c.headline ? '*' : ' ';
  // Latency metrics below the significance floor are reported, never gated.
  const belowFloor = c.unit === 'ms' && Math.max(b.value, c.value) < minMs;
  const regressed = c.headline && reg > threshold && !belowFloor;
  if (regressed) failed = true;
  const verdict = regressed ? 'FAIL' : belowFloor && c.headline && reg > threshold ? 'noise' : 'ok';
  const sign = reg >= 0 ? '+' : '';
  lines.push(
    `  ${flag} ${c.id.padEnd(28)} base=${b.value.toFixed(2).padStart(10)}  cand=${c.value.toFixed(2).padStart(10)}  ${(sign + reg.toFixed(1) + '%').padStart(9)}  ${verdict}`,
  );
}

console.log(`Perf comparison (threshold ${threshold}% on headline metrics, * = headline):\n`);
console.log(lines.join('\n'));

if (failed) {
  console.error(`\n✗ Performance regression: a headline metric regressed more than ${threshold}%.`);
  process.exit(1);
}
console.log('\n✓ No headline regression beyond threshold.');
process.exit(0);
