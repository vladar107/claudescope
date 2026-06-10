/**
 * Pure statistics helpers for the perf suite. No server/DuckDB imports — used
 * by both scenarios.ts (sampling) and compare.ts (gating), and compare.ts must
 * stay importable without pulling in the index.
 */

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const percentile = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
};

/** Interquartile range — robust spread for the ±IQR display. */
export const iqr = (xs: number[]): number => percentile(xs, 75) - percentile(xs, 25);

/** Coefficient of variation (stddev / mean); 0 for empty or zero-mean samples. */
export function cv(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (m === 0) return 0;
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance) / Math.abs(m);
}

/** Standard normal CDF (Zelen & Severo / A&S 7.1.26, |err| < 7.5e-8). */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/**
 * One-sided Mann-Whitney U test: p-value for the alternative "samples in `y`
 * are stochastically GREATER than samples in `x`". Normal approximation with
 * midranks, tie correction, and continuity correction — fine for the pooled
 * sample sizes the suite produces (~10+ per side). Returns 1 (no evidence)
 * when a side is empty or every value is tied.
 */
export function mannWhitneyGreater(x: number[], y: number[]): number {
  const n1 = x.length;
  const n2 = y.length;
  if (n1 === 0 || n2 === 0) return 1;
  const all = [...x.map((v) => ({ v, isY: false })), ...y.map((v) => ({ v, isY: true }))].sort(
    (a, b) => a.v - b.v,
  );
  const n = n1 + n2;
  const ranks = new Array<number>(n);
  let tieAdj = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && all[j + 1].v === all[i].v) j++;
    const midrank = (i + j + 2) / 2; // ranks are 1-based
    for (let k = i; k <= j; k++) ranks[k] = midrank;
    const ties = j - i + 1;
    if (ties > 1) tieAdj += ties ** 3 - ties;
    i = j + 1;
  }
  let rankSumY = 0;
  for (let k = 0; k < n; k++) if (all[k].isY) rankSumY += ranks[k];
  const u = rankSumY - (n2 * (n2 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const sigma2 = ((n1 * n2) / 12) * (n + 1 - tieAdj / (n * (n - 1)));
  if (sigma2 <= 0) return 1; // all values identical
  const z = (u - mu - 0.5) / Math.sqrt(sigma2);
  return 1 - normalCdf(z);
}
