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
  /** Display value: median of `samples`. */
  value: number;
  /** Headline metrics gate CI; the rest are informational. */
  headline: boolean;
  /** True when a lower value is better (latency); false for throughput. */
  betterIsLower: boolean;
  /**
   * Raw per-sample values in `unit`. The comparator pools these across result
   * files (one per interleaved CI round) for the statistical gate. Absent in
   * schema-v1 files, which compare.ts treats as advisory-only.
   */
  samples: number[];
  /** How many timed iterations each sample aggregates (1 = unbatched). */
  itersPerSample: number;
}

export interface BenchResult {
  meta: {
    /** Result-file format version; bumped when `samples` were added. */
    schemaVersion: number;
    timestamp: string;
    node: string;
    scale: number;
    runs: number;
    totalEvents: number;
    totalBytes: number;
  };
  metrics: Metric[];
}
