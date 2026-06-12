/**
 * GET /api/analytics — token + cost aggregation grouped by project, model, or
 * day, with overall totals and a cache-hit ratio.
 *
 * cacheHitRatio = cache_read / (cache_read + input). Computed both per-row and
 * for the totals. Optional inclusive date bounds `from` / `to` filter on the
 * event timestamp.
 *
 * Token/cost SUMs and messageCount filter on `usage_canonical` so one billed API
 * call counts once (Claude Code writes a row per content block and copies usage
 * across fork sessions); messageCount is therefore "billed API calls, deduped".
 */

import type { FastifyInstance } from 'fastify';
import type {
  AnalyticsGroupBy,
  AnalyticsResponse,
  AnalyticsRow,
  AnalyticsTotals,
} from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { projectIdFromCwd } from '../data/project-id.js';

/**
 * The grouping key expression plus the FROM clause it needs. Project grouping
 * joins through the sessions table so a session's events all roll up to its
 * canonical modal project_cwd — matching the project ids returned by
 * /api/projects — rather than fragmenting across mid-session sub-directory cwds.
 */
function groupSource(groupBy: AnalyticsGroupBy): { keyExpr: string; fromSql: string } {
  switch (groupBy) {
    case 'model':
      return { keyExpr: "COALESCE(e.model, 'unknown')", fromSql: 'FROM events e' };
    case 'day':
      return { keyExpr: "strftime(e.ts, '%Y-%m-%d')", fromSql: 'FROM events e' };
    case 'agent':
      return {
        keyExpr: "COALESCE(s.connector_id, 'unknown')",
        fromSql: 'FROM events e JOIN sessions s ON e.session_id = s.id',
      };
    case 'project':
    default:
      return {
        keyExpr: "COALESCE(s.project_cwd, 'unknown')",
        fromSql: 'FROM events e JOIN sessions s ON e.session_id = s.id',
      };
  }
}

/**
 * Fraction of prompt tokens served from cache:
 *   cache_read / (cache_read + cache_creation + input)
 * Cache-creation (writes) and uncached input are both freshly processed, so
 * they belong in the denominator — otherwise the ratio pins at ~100%.
 */
function cacheHitRatio(cacheRead: number, cacheWrite: number, input: number): number {
  const denom = cacheRead + cacheWrite + input;
  return denom > 0 ? cacheRead / denom : 0;
}

export async function registerAnalyticsRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { groupBy?: string; from?: string; to?: string };
  }>('/api/analytics', async (req): Promise<AnalyticsResponse> => {
    const conn = await getConnection();
    const groupBy = (req.query.groupBy as AnalyticsGroupBy) ?? 'project';
    const { keyExpr, fromSql } = groupSource(groupBy);

    const filters: string[] = ["e.type = 'assistant'"];
    if (req.query.from) filters.push(`e.ts >= ${sqlString(req.query.from)}::TIMESTAMP`);
    if (req.query.to) filters.push(`e.ts <= ${sqlString(req.query.to)}::TIMESTAMP`);
    const whereSql = `WHERE ${filters.join(' AND ')}`;

    const rows = await queryRows(
      conn,
      `SELECT
         ${keyExpr} AS group_key,
         sum(e.input_tokens) FILTER (WHERE e.usage_canonical) AS input_tokens,
         sum(e.output_tokens) FILTER (WHERE e.usage_canonical) AS output_tokens,
         sum(e.cache_write_tokens) FILTER (WHERE e.usage_canonical) AS cache_write_tokens,
         sum(e.cache_read_tokens) FILTER (WHERE e.usage_canonical) AS cache_read_tokens,
         sum(e.cost_usd) FILTER (WHERE e.usage_canonical) AS cost_usd,
         count(*) FILTER (WHERE e.usage_canonical) AS message_count
       ${fromSql}
       ${whereSql}
       GROUP BY group_key
       ORDER BY cost_usd DESC`,
    );

    const resultRows: AnalyticsRow[] = rows.map((r) => {
      const input = Number(r.input_tokens ?? 0);
      const output = Number(r.output_tokens ?? 0);
      const cacheWrite = Number(r.cache_write_tokens ?? 0);
      const cacheRead = Number(r.cache_read_tokens ?? 0);
      let key = String(r.group_key ?? '');
      // For project grouping, expose the slug id (matches /api/projects ids).
      if (groupBy === 'project' && key && key !== 'unknown') {
        key = projectIdFromCwd(key);
      }
      return {
        key,
        inputTokens: input,
        outputTokens: output,
        cacheCreationTokens: cacheWrite,
        cacheReadTokens: cacheRead,
        totalTokens: input + output + cacheWrite + cacheRead,
        costUsd: Number(r.cost_usd ?? 0),
        cacheHitRatio: cacheHitRatio(cacheRead, cacheWrite, input),
        messageCount: Number(r.message_count ?? 0),
      };
    });

    const totals: AnalyticsTotals = resultRows.reduce<AnalyticsTotals>(
      (acc, row) => {
        acc.inputTokens += row.inputTokens;
        acc.outputTokens += row.outputTokens;
        acc.cacheCreationTokens += row.cacheCreationTokens;
        acc.cacheReadTokens += row.cacheReadTokens;
        acc.totalTokens += row.totalTokens;
        acc.costUsd += row.costUsd;
        acc.messageCount += row.messageCount;
        return acc;
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        cacheHitRatio: 0,
        messageCount: 0,
      },
    );
    totals.cacheHitRatio = cacheHitRatio(
      totals.cacheReadTokens,
      totals.cacheCreationTokens,
      totals.inputTokens,
    );

    return { rows: resultRows, totals };
  });
}
