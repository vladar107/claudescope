/**
 * Derived analytics metrics with more than one consumer.
 *
 * The cache-hit ratio had three implementations: byte-identical TypeScript
 * functions in `routes/analytics.ts` and `routes/analytics-agents.ts`, plus the
 * same formula hand-written as SQL in `routes/analytics-sessions.ts`. Worse, the
 * header comment on `analytics.ts` documented a DIFFERENT formula from the one
 * its own code computed — so a reader trusting the doc would get a different
 * number.
 *
 * Both representations are needed and neither can replace the other: the SQL one
 * has to exist because `/api/analytics/sessions` makes `cache_hit_ratio` a
 * sortable column and feeds it to `quantile_cont` for the median/quartile
 * summary. So the formula is stated once here, in prose, with the two encodings
 * beside it — and a test evaluates the SQL in DuckDB against the TS function on
 * the same inputs, so they cannot drift silently.
 */

/**
 * THE FORMULA — fraction of prompt tokens served from cache:
 *
 * ```text
 *   cache_read / (cache_read + cache_write + input)
 * ```
 *
 * Cache *writes* and uncached input are both freshly processed, so they belong in
 * the denominator; leaving `cache_write` out pins the ratio near 100% for any
 * session that primed a large cache. A zero denominator yields 0, not NaN.
 */
export function cacheHitRatio(cacheRead: number, cacheWrite: number, input: number): number {
  const denominator = cacheRead + cacheWrite + input;
  return denominator > 0 ? cacheRead / denominator : 0;
}

/**
 * {@link cacheHitRatio} as a SQL expression over three (possibly NULL) column
 * expressions. Each is COALESCEd to 0, and the division is forced to DOUBLE so
 * integer token columns don't truncate to 0.
 */
export function cacheHitRatioSql(cacheRead: string, cacheWrite: string, input: string): string {
  const read = `COALESCE(${cacheRead}, 0)`;
  const denominator = `(${read} + COALESCE(${cacheWrite}, 0) + COALESCE(${input}, 0))`;
  return `CASE WHEN ${denominator} > 0 THEN ${read}::DOUBLE / ${denominator} ELSE 0 END`;
}
