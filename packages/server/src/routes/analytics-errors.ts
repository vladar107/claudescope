/**
 * GET /api/analytics/errors — per-agent error/interrupt signals over the
 * sessions in scope (optional project + date bounds on the session START —
 * sessions are atomic here, like /api/analytics/sessions).
 *
 * Tool calls and tool errors are both per-row counts, so they dedup fork copies
 * only — never through `usage_canonical`, which would drop the tool_use blocks
 * of every split message. See THE RULE in `data/analytics-metrics.ts`; this is
 * what keeps the numbers here equal to /api/analytics/tools.
 *
 * Two signals with very different availability, both exposed n/a-aware:
 *  - Tool errors: sums of `events.tool_error_count` (whichever rows carry the
 *    tool_result — user rows for Claude Code/Codex, see the SQL comment).
 *    The column is NULL for formats with no error signal (Junie's plain-string
 *    results, Antigravity's typed records), and SQL SUM keeps an all-NULL group
 *    NULL — so `toolErrors: null` means "can't know", never 0. Copilot counts
 *    permission-denied calls as errors (see plan 0039's open question).
 *  - User interrupts: the `[Request interrupted by user…]` marker Claude Code
 *    writes as the user-message text. Prefix-anchored match (an ordinary
 *    message *quoting* the marker mid-text must not count), with the same
 *    sidechain/fork exclusions as the activity punchcard. Claude-Code-only.
 *
 * `errorSignalsByAgent` is exported for the digest route, which rolls the same
 * aggregation up instead of re-deriving it.
 */

import type { FastifyInstance } from 'fastify';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { ErrorAnalyticsResponse, ErrorAnalyticsRow } from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { scopeFilters } from '../data/analytics-scope.js';
import { toolCallRowsSql } from '../data/analytics-metrics.js';
import { errorAvailabilityNote, hasInterruptSignal } from '../data/agent-capabilities.js';

/** Prefix of the user-message text Claude Code stores on an interrupt (both
 *  variants: `…by user]` and `…by user for tool use]`). */
const INTERRUPT_PREFIX = '[Request interrupted by user';

export interface ErrorScope {
  project?: string;
  from?: string;
  to?: string;
  timeZone?: string;
}

/** Raw per-agent aggregates, before n/a shaping. */
export interface ErrorSignals {
  connectorId: string;
  sessions: number;
  toolCalls: number;
  /** NULL when every row's tool_error_count is NULL (format has no signal). */
  toolErrors: number | null;
  /** Raw marker count — only meaningful for claude-code. */
  interrupts: number;
}

/**
 * Per-agent tool-call/error/interrupt sums over the sessions in scope. Shared
 * by /api/analytics/errors and the digest.
 */
export async function errorSignalsByAgent(
  conn: DuckDBConnection,
  scope: ErrorScope,
): Promise<ErrorSignals[]> {
  const filters = await scopeFilters(conn, scope);
  const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = await queryRows(
    conn,
    `WITH scoped AS (SELECT id, connector_id FROM sessions ${whereSql})
     SELECT
       COALESCE(sc.connector_id, 'unknown') AS connector_id,
       count(DISTINCT sc.id) AS sessions,
       COALESCE(sum(e.tool_use_count) FILTER (WHERE e.type = 'assistant' AND ${toolCallRowsSql()}), 0) AS tool_calls,
       -- Errors live wherever the connector recorded the tool_result (user rows
       -- for Claude Code/Codex), so no type filter — only the fork exclusion. If
       -- the original file is later deleted the surviving copy goes uncounted —
       -- an accepted edge, same as the interrupt count.
       sum(e.tool_error_count) FILTER (WHERE ${toolCallRowsSql()}) AS tool_errors,
       count(*) FILTER (
         WHERE e.type = 'user' AND NOT e.is_sidechain AND e.forked_from_session_id IS NULL
           AND e.text_content LIKE ${sqlString(`${INTERRUPT_PREFIX}%`)}
       ) AS interrupts
     FROM scoped sc
     LEFT JOIN events e ON e.session_id = sc.id
     GROUP BY COALESCE(sc.connector_id, 'unknown')
     ORDER BY sessions DESC, connector_id`,
  );

  return rows.map((r) => {
    const rd = readRow(r, 'analytics-errors');
    const rawErrors = rd.opt('tool_errors');
    return {
      connectorId: rd.str('connector_id', 'unknown'),
      sessions: rd.num('sessions'),
      toolCalls: rd.num('tool_calls'),
      toolErrors: rawErrors == null ? null : Number(rawErrors),
      interrupts: rd.num('interrupts'),
    };
  });
}

export async function registerErrorsRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { project?: string; from?: string; to?: string; timeZone?: string };
  }>('/api/analytics/errors', async (req): Promise<ErrorAnalyticsResponse> => {
    const conn = await getConnection();
    const signals = await errorSignalsByAgent(conn, req.query);

    const rows: ErrorAnalyticsRow[] = signals.map((s) => {
      const interrupted = hasInterruptSignal(s.connectorId);
      const note = errorAvailabilityNote(s.connectorId);
      return {
        connectorId: s.connectorId,
        sessions: s.sessions,
        toolCalls: s.toolCalls,
        toolErrors: s.toolErrors,
        errorRate: s.toolErrors === null || s.toolCalls === 0 ? null : s.toolErrors / s.toolCalls,
        interrupts: interrupted ? s.interrupts : null,
        interruptsPerSession: interrupted && s.sessions > 0 ? s.interrupts / s.sessions : null,
        ...(note ? { availabilityNote: note } : {}),
      };
    });

    return { rows };
  });
}
