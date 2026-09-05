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

/**
 * THE RULE — an aggregate over `events` deduplicates one of two ways, and which
 * one depends on what the column measures:
 *
 *  - **Token/cost SUMs dedup by billed API call** ({@link usageRowsSql}). Claude
 *    Code writes one row per content block of an assistant message; every row
 *    shares the `message.id` and repeats the FULL `usage`, and a fork copies the
 *    lot into a second file. `electCanonicalUsage` (see `data/index.ts`) elects
 *    exactly one row per `message_id`, so summing only elected rows counts each
 *    billed call once.
 *  - **Per-row COUNTS dedup fork copies only** ({@link toolCallRowsSql}):
 *    `tool_use_count`, the `tool_names`/`skill_names` unnest, and
 *    `tool_error_count` live on the SPECIFIC rows carrying those blocks — and
 *    since only one row per message can win the usage election, most of them
 *    LOSE it. Filtering these on `usage_canonical` hides the majority of real
 *    tool calls (measured on a real index: 4974 Claude Code calls counted the
 *    right way vs 2728 through the election). The only duplicates a per-row
 *    count has to fear are fork copies, which carry `forked_from_session_id`.
 *
 * `tool_error_count` sits on the USER rows carrying the tool_results, whose
 * `message_id` is NULL and which are therefore always canonical — so there the
 * usage filter was a no-op and the fork exclusion is the whole dedup.
 *
 * The two rules are not interchangeable, and a route that mixes them reports a
 * tool-call number that contradicts /api/analytics/tools.
 */

/** Rows to SUM tokens/cost over: one elected row per billed API call. */
export function usageRowsSql(alias = 'e'): string {
  return `${alias ? `${alias}.` : ''}usage_canonical`;
}

/**
 * Rows to COUNT tool calls / tool errors over: everything except fork copies.
 * Pass `''` for an unaliased query (the indexer's `FROM events`).
 */
export function toolCallRowsSql(alias = 'e'): string {
  return `${alias ? `${alias}.` : ''}forked_from_session_id IS NULL`;
}
