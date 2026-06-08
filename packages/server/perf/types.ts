/**
 * Shared types for the performance suite. No server/DuckDB imports here so the
 * comparator (compare.ts) can read result files without pulling in the index.
 */

export interface Metric {
  /** Stable id `scenario.metric` used to pair base vs candidate. */
  id: string;
  /** Human label for the table. */
  label: string;
  unit: string;
  value: number;
  /** Headline metrics gate CI; the rest are informational. */
  headline: boolean;
  /** True when a lower value is better (latency); false for throughput. */
  betterIsLower: boolean;
}

export interface BenchResult {
  meta: {
    timestamp: string;
    node: string;
    scale: number;
    runs: number;
    totalEvents: number;
    totalBytes: number;
  };
  metrics: Metric[];
}
