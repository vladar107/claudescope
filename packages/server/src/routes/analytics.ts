/**
 * GET /api/analytics — token + cost aggregation grouped by project, model, or
 * day, with overall totals and a cache-hit ratio.
 *
 * cacheHitRatio is the shared formula in `data/analytics-metrics.ts` — computed
 * both per-row and for the totals. (This header used to document
 * `cache_read / (cache_read + input)`, which is NOT what the code computed:
 * `cache_write` belongs in the denominator too.) Optional inclusive date bounds
 * `from` / `to` filter on the event timestamp; an optional `project` id narrows
 * every grouping to that project's sessions.
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
import { getConnection, queryRows } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { cacheHitRatio } from '../data/analytics-metrics.js';
import {
  analyticsTimeZone,
  localTimestampSql,
  scopeFilters,
} from '../data/analytics-scope.js';
import { projectIdFromCwd } from '../data/project-id.js';
import { enumParam } from '../params.js';

const ANALYTICS_GROUPS = ['project', 'model', 'day', 'agent'] as const;

const WITH_SESSIONS = 'FROM events e JOIN sessions s ON e.session_id = s.id';

/**
 * The grouping key expression plus the FROM clause it needs. Project grouping
 * joins through the sessions table so a session's events all roll up to its
 * canonical modal project_cwd — matching the project ids returned by
 * /api/projects — rather than fragmenting across mid-session sub-directory cwds.
 * `withSessions` forces that join for the other groupings too, so a project
 * filter on `s.project_cwd` selects exactly the events of that project's row.
 */
function groupSource(
  groupBy: AnalyticsGroupBy,
  timeZone: string,
  withSessions: boolean,
): { keyExpr: string; fromSql: string } {
  const eventsOnly = withSessions ? WITH_SESSIONS : 'FROM events e';
  switch (groupBy) {
    case 'model':
      return { keyExpr: "COALESCE(e.model, 'unknown')", fromSql: eventsOnly };
    case 'day':
      return {
        keyExpr: `strftime(${localTimestampSql('e.ts', timeZone)}, '%Y-%m-%d')`,
        fromSql: eventsOnly,
      };
    case 'agent':
      return { keyExpr: "COALESCE(s.connector_id, 'unknown')", fromSql: WITH_SESSIONS };
    case 'project':
    default:
      return { keyExpr: "COALESCE(s.project_cwd, 'unknown')", fromSql: WITH_SESSIONS };
  }
}

export async function registerAnalyticsRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { groupBy?: string; project?: string; from?: string; to?: string; timeZone?: string };
  }>('/api/analytics', async (req): Promise<AnalyticsResponse> => {
    const conn = await getConnection();
    const groupBy = enumParam(req.query.groupBy, 'groupBy', ANALYTICS_GROUPS, 'project');
    const timeZone = await analyticsTimeZone(conn, req.query.timeZone);
    const project = req.query.project || undefined;
    const { keyExpr, fromSql } = groupSource(groupBy, timeZone, project !== undefined);

    // Scope goes through the shared helper (which validates the bounds); this
    // route filters the EVENT timestamp, not the session start, hence the `ts`
    // override, and the session's canonical project, hence the `cwd` one.
    const filters: string[] = [
      "e.type = 'assistant'",
      ...(await scopeFilters(
        conn,
        { project, from: req.query.from, to: req.query.to, timeZone },
        { cwd: 's.project_cwd', ts: 'e.ts' },
      )),
    ];
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
      const rd = readRow(r, 'analytics');
      const input = rd.num('input_tokens');
      const output = rd.num('output_tokens');
      const cacheWrite = rd.num('cache_write_tokens');
      const cacheRead = rd.num('cache_read_tokens');
      let key = rd.str('group_key');
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
        costUsd: rd.num('cost_usd'),
        cacheHitRatio: cacheHitRatio(cacheRead, cacheWrite, input),
        messageCount: rd.num('message_count'),
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
