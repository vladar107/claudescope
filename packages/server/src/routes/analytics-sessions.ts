/**
 * GET /api/analytics/sessions — per-session efficiency ratios.
 *
 * Same aggregation semantics as /api/analytics (assistant events,
 * usage_canonical dedup, the shared cache-hit denominator) but GROUP BY
 * session_id, joined to the derived `sessions` table for identity. Returns the
 * Top-N rows by the chosen sort plus a median summary over the FULL filtered set.
 *
 * Date bounds filter on the session START — a session is atomic here, so
 * per-event windowing would half-count a session straddling the boundary. The
 * minResponses floor (clamped ≥1) guarantees every returned row has D ≥ 1, so the
 * per-response ratios are always finite numbers.
 */
import type { FastifyInstance } from 'fastify';
import type {
  SessionEfficiencyResponse,
  SessionEfficiencyRow,
  SessionEfficiencySort,
} from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { projectIdFromCwd, displayNameFromCwd } from '../data/project-id.js';
import { toIso } from './projects.js';

// Whitelist: sort key -> ORDER BY column. Never interpolate the raw param.
const SORT_EXPR: Record<SessionEfficiencySort, string> = {
  cost: 'cost_usd',
  tokens: 'total_tokens',
  responses: 'responses',
  duration: 'duration_ms',
  cacheHitRatio: 'cache_hit_ratio',
  costPerResponse: 'cost_per_response',
  tokensPerResponse: 'tokens_per_response',
  toolCallsPerResponse: 'tool_calls_per_response',
};

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = raw === undefined ? dflt : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export async function registerSessionEfficiencyRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { from?: string; to?: string; sort?: string; limit?: string; minResponses?: string };
  }>('/api/analytics/sessions', async (req): Promise<SessionEfficiencyResponse> => {
    const conn = await getConnection();

    const sort: SessionEfficiencySort =
      req.query.sort && req.query.sort in SORT_EXPR
        ? (req.query.sort as SessionEfficiencySort)
        : 'cost';
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const minResponses = clampInt(req.query.minResponses, 1, 1, 1_000_000);
    const fromClause = req.query.from ? `AND s.started_at >= ${sqlString(req.query.from)}::TIMESTAMP` : '';
    const toClause = req.query.to ? `AND s.started_at <= ${sqlString(req.query.to)}::TIMESTAMP` : '';

    // Shared CTE: per-session deduped sums -> derived ratios, filtered.
    const cte = `
      WITH agg AS (
        SELECT
          e.session_id AS session_id,
          sum(e.input_tokens)       FILTER (WHERE e.usage_canonical) AS input_tokens,
          sum(e.output_tokens)      FILTER (WHERE e.usage_canonical) AS output_tokens,
          sum(e.cache_write_tokens) FILTER (WHERE e.usage_canonical) AS cache_write_tokens,
          sum(e.cache_read_tokens)  FILTER (WHERE e.usage_canonical) AS cache_read_tokens,
          sum(e.cost_usd)           FILTER (WHERE e.usage_canonical) AS cost_usd,
          -- tool_use_count is deduped via usage_canonical here (deliberately unlike
          -- sessions.tool_call_count, which sums it un-deduped) so fork/resume copies
          -- don't double-count tools — keeping it consistent with the token/cost sums.
          sum(e.tool_use_count)     FILTER (WHERE e.usage_canonical) AS tool_call_count,
          count(*)                  FILTER (WHERE e.usage_canonical) AS responses
        FROM events e
        WHERE e.type = 'assistant'
        GROUP BY e.session_id
      ),
      derived AS (
        SELECT
          a.session_id,
          s.title, s.title_derived, s.project_cwd, s.connector_id,
          s.started_at, s.ended_at,
          COALESCE(a.input_tokens, 0)       AS input_tokens,
          COALESCE(a.output_tokens, 0)      AS output_tokens,
          COALESCE(a.cache_write_tokens, 0) AS cache_write_tokens,
          COALESCE(a.cache_read_tokens, 0)  AS cache_read_tokens,
          COALESCE(a.cost_usd, 0)           AS cost_usd,
          COALESCE(a.tool_call_count, 0)    AS tool_call_count,
          a.responses                       AS responses,
          (COALESCE(a.input_tokens,0) + COALESCE(a.output_tokens,0)
            + COALESCE(a.cache_write_tokens,0) + COALESCE(a.cache_read_tokens,0)) AS total_tokens,
          CASE
            WHEN (COALESCE(a.cache_read_tokens,0) + COALESCE(a.cache_write_tokens,0) + COALESCE(a.input_tokens,0)) > 0
            THEN COALESCE(a.cache_read_tokens,0)::DOUBLE
                 / (COALESCE(a.cache_read_tokens,0) + COALESCE(a.cache_write_tokens,0) + COALESCE(a.input_tokens,0))
            ELSE 0
          END AS cache_hit_ratio,
          COALESCE(a.cost_usd,0)::DOUBLE / NULLIF(a.responses, 0) AS cost_per_response,
          (COALESCE(a.input_tokens,0) + COALESCE(a.output_tokens,0)
            + COALESCE(a.cache_write_tokens,0) + COALESCE(a.cache_read_tokens,0))::DOUBLE
            / NULLIF(a.responses, 0) AS tokens_per_response,
          COALESCE(a.tool_call_count,0)::DOUBLE / NULLIF(a.responses, 0) AS tool_calls_per_response,
          CASE
            WHEN s.ended_at IS NOT NULL AND s.started_at IS NOT NULL
            THEN epoch_ms(s.ended_at) - epoch_ms(s.started_at)
            ELSE 0
          END AS duration_ms
        FROM agg a
        JOIN sessions s ON s.id = a.session_id
        WHERE a.responses >= ${minResponses}
          ${fromClause}
          ${toClause}
      )
    `;

    const rowsRaw = await queryRows(
      conn,
      `${cte}
       SELECT * FROM derived
       ORDER BY ${SORT_EXPR[sort]} DESC NULLS LAST, started_at DESC NULLS LAST, session_id
       LIMIT ${limit}`,
    );

    const rows: SessionEfficiencyRow[] = rowsRaw.map((r) => {
      const rd = readRow(r, 'session-efficiency');
      const cwd = rd.str('project_cwd');
      return {
        sessionId: rd.str('session_id'),
        title: rd.str('title'),
        titleDerived: rd.bool('title_derived'),
        projectId: cwd ? projectIdFromCwd(cwd) : 'unknown',
        projectDisplayName: cwd ? displayNameFromCwd(cwd) : 'unknown',
        connectorId: rd.str('connector_id', 'unknown'),
        startedAt: toIso(rd.req('started_at')),
        endedAt: toIso(rd.req('ended_at')),
        durationMs: rd.num('duration_ms'),
        responses: rd.num('responses'),
        totalTokens: rd.num('total_tokens'),
        costUsd: rd.num('cost_usd'),
        toolCallCount: rd.num('tool_call_count'),
        cacheHitRatio: rd.num('cache_hit_ratio'),
        costPerResponse: rd.num('cost_per_response'),
        tokensPerResponse: rd.num('tokens_per_response'),
        toolCallsPerResponse: rd.num('tool_calls_per_response'),
      };
    });

    // Per-column median + quartiles over the FULL filtered set — drives the UI's
    // median reference row and the IQR outlier fences (lo = q1 − 1.5·IQR,
    // hi = q3 + 1.5·IQR). quantile_cont over an empty set returns NULL, which
    // readRow turns into 0.
    const statCols = [
      'responses',
      'cost_usd',
      'cost_per_response',
      'tool_call_count',
      'tool_calls_per_response',
      'cache_hit_ratio',
    ];
    const quantileExprs = statCols
      .map(
        (c) =>
          `quantile_cont(${c}, 0.25) AS ${c}_q1, ` +
          `quantile_cont(${c}, 0.5) AS ${c}_med, ` +
          `quantile_cont(${c}, 0.75) AS ${c}_q3`,
      )
      .join(',\n         ');

    const summaryRows = await queryRows(
      conn,
      `${cte}
       SELECT
         count(*) AS session_count,
         COALESCE(sum(cost_usd), 0) AS total_cost,
         COALESCE((SELECT sum(c) FROM (SELECT cost_usd AS c FROM derived ORDER BY cost_usd DESC LIMIT 3)), 0) AS top3_cost,
         ${quantileExprs}
       FROM derived`,
    );
    const sr = readRow(summaryRows[0] ?? {}, 'session-efficiency-summary');
    const stat = (c: string) => ({
      median: sr.num(`${c}_med`),
      q1: sr.num(`${c}_q1`),
      q3: sr.num(`${c}_q3`),
    });

    return {
      rows,
      summary: {
        sessionCount: sr.num('session_count'),
        totalCostUsd: sr.num('total_cost'),
        top3CostUsd: sr.num('top3_cost'),
        columns: {
          responses: stat('responses'),
          costUsd: stat('cost_usd'),
          costPerResponse: stat('cost_per_response'),
          toolCallCount: stat('tool_call_count'),
          toolCallsPerResponse: stat('tool_calls_per_response'),
          cacheHitRatio: stat('cache_hit_ratio'),
        },
      },
    };
  });
}
