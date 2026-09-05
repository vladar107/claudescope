/**
 * GET /api/analytics/digest — a composed "week in review" over the sessions in
 * range (default: the last 7 days ending now). No schema of its own: it rolls
 * up the sessions/events/file_edits tables plus the shared error aggregation
 * (`errorSignalsByAgent`) and the streak helper (`computeStreaks`).
 *
 * Semantics, consistent with the rest of analytics:
 *  - Session-atomic range: a session belongs to the range its START falls in;
 *    all of its events/edits count with it.
 *  - Token/cost sums are session-level (already usage-deduped at derivation) —
 *    they naturally cover only agents that report usage.
 *  - Code impact reads canonical `file_edits` rows (fork-deduped at index time).
 *  - The streak is all-time (local days) as of the range end — momentum, not a
 *    range-bound stat.
 */

import type { FastifyInstance } from 'fastify';
import type {
  DigestCountRow,
  DigestErrors,
  DigestProjectRow,
  DigestResponse,
} from '@claudescope/shared';
import type { DuckDBConnection } from '@duckdb/node-api';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import {
  analyticsBoundSql,
  analyticsTimeZone,
  localTimestampSql,
  scopeFilters,
} from '../data/analytics-scope.js';
import { readRow } from '../db/row.js';
import { projectIdFromCwd } from '../data/project-id.js';
import { toolCallRowsSql } from '../data/analytics-metrics.js';
import { errorSignalsByAgent } from './analytics-errors.js';
import { hasInterruptSignal } from '../data/agent-capabilities.js';
import { computeStreaks } from './analytics-activity.js';
import { timestampParam } from '../params.js';

const TOP_LIMIT = 5;

/** Default range: the last 7 local calendar days ending now. */
async function defaultRange(
  conn: DuckDBConnection,
  timeZone: string,
): Promise<{ from: string; to: string }> {
  const now = new Date();
  const rows = await queryRows(
    conn,
    `SELECT strftime(
       timezone(${sqlString(timeZone)}, ${sqlString(now.toISOString())}::TIMESTAMPTZ)
         - INTERVAL 6 DAY,
       '%Y-%m-%d'
     ) AS day`,
  );
  return {
    from: readRow(rows[0] ?? {}, 'digest-default-range').str('day'),
    to: now.toISOString(),
  };
}

export async function registerDigestRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { from?: string; to?: string; timeZone?: string };
  }>('/api/analytics/digest', async (req): Promise<DigestResponse> => {
    const conn = await getConnection();
    const timeZone = await analyticsTimeZone(conn, req.query.timeZone);
    const range = await defaultRange(conn, timeZone);
    const from = timestampParam(req.query.from, 'from') ?? range.from;
    const to = timestampParam(req.query.to, 'to') ?? range.to;

    // Shared (validated) bounds on the session start — a session belongs to the
    // range its START falls in. Both bounds are always present (defaultRange).
    const filters = await scopeFilters(conn, { from, to, timeZone });
    const whereSql = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const scopedCte = `WITH scoped AS (SELECT * FROM sessions ${whereSql})`;

    // Totals — session-level sums, plus canonical assistant responses.
    const totalsRaw = await queryRows(
      conn,
      `${scopedCte}
       SELECT count(*) AS sessions,
              count(DISTINCT project_cwd) AS projects,
              COALESCE(sum(total_tokens), 0) AS tokens,
              COALESCE(sum(total_cost_usd), 0) AS cost
       FROM scoped`,
    );
    const td = readRow(totalsRaw[0] ?? {}, 'digest-totals');
    const sessions = td.num('sessions');

    const responsesRaw = await queryRows(
      conn,
      `${scopedCte}
       SELECT count(*) AS responses
       FROM events e JOIN scoped s ON e.session_id = s.id
       WHERE e.type = 'assistant' AND e.usage_canonical`,
    );

    // Top projects by cost.
    const projectsRaw = await queryRows(
      conn,
      `${scopedCte}
       SELECT COALESCE(project_cwd, '') AS cwd, count(*) AS sessions,
              COALESCE(sum(total_tokens), 0) AS tokens, COALESCE(sum(total_cost_usd), 0) AS cost
       FROM scoped
       GROUP BY COALESCE(project_cwd, '')
       ORDER BY cost DESC, sessions DESC
       LIMIT ${TOP_LIMIT}`,
    );
    const topProjects: DigestProjectRow[] = projectsRaw.map((r) => {
      const rd = readRow(r, 'digest-projects');
      const cwd = rd.str('cwd');
      return {
        projectId: cwd ? projectIdFromCwd(cwd) : '',
        cwd,
        sessions: rd.num('sessions'),
        totalTokens: rd.num('tokens'),
        costUsd: rd.num('cost'),
      };
    });

    const countRows = async (sql: string, ctx: string): Promise<DigestCountRow[]> =>
      (await queryRows(conn, sql)).map((r) => {
        const rd = readRow(r, ctx);
        return { key: rd.str('key', 'unknown'), count: rd.num('count') };
      });

    // Model mix (canonical assistant responses per model).
    const models = await countRows(
      `${scopedCte}
       SELECT COALESCE(e.model, 'unknown') AS key, count(*) AS count
       FROM events e JOIN scoped s ON e.session_id = s.id
       WHERE e.type = 'assistant' AND e.usage_canonical
       GROUP BY key ORDER BY count DESC, key LIMIT ${TOP_LIMIT}`,
      'digest-models',
    );

    // Tool mix (unnest the CSV, same semantics as /api/analytics/tools).
    const topTools = await countRows(
      `${scopedCte}
       SELECT tool AS key, count(*) AS count
       FROM (
         SELECT unnest(string_split(e.tool_names, ',')) AS tool
         FROM events e JOIN scoped s ON e.session_id = s.id
         WHERE e.type = 'assistant' AND ${toolCallRowsSql()} AND e.tool_names <> ''
       ) t
       WHERE tool <> ''
       GROUP BY tool ORDER BY count DESC, tool LIMIT ${TOP_LIMIT}`,
      'digest-tools',
    );

    // Sessions per agent.
    const agents = await countRows(
      `${scopedCte}
       SELECT COALESCE(connector_id, 'unknown') AS key, count(*) AS count
       FROM scoped GROUP BY key ORDER BY count DESC, key`,
      'digest-agents',
    );

    // Biggest session by cost (tokens as tiebreak, e.g. a zero-cost corpus).
    const biggestRaw = await queryRows(
      conn,
      `${scopedCte}
       SELECT id, title, connector_id, total_cost_usd, total_tokens
       FROM scoped ORDER BY total_cost_usd DESC, total_tokens DESC LIMIT 1`,
    );
    const biggestSession = biggestRaw.length
      ? (() => {
          const rd = readRow(biggestRaw[0] as Record<string, unknown>, 'digest-biggest');
          return {
            id: rd.str('id'),
            title: rd.str('title'),
            connectorId: rd.str('connector_id', 'unknown'),
            costUsd: rd.num('total_cost_usd'),
            totalTokens: rd.num('total_tokens'),
          };
        })()
      : null;

    // All-time prompt streak (local days) as of the range end.
    const dayRows = await queryRows(
      conn,
      `SELECT DISTINCT strftime(${localTimestampSql('e.ts', timeZone)}, '%Y-%m-%d') AS day
       FROM events e
       WHERE e.type = 'user' AND NOT e.is_sidechain AND e.forked_from_session_id IS NULL`,
    );
    const todayRows = await queryRows(
      conn,
      `SELECT strftime(
         timezone(${sqlString(timeZone)}, ${analyticsBoundSql(to, timeZone)}),
         '%Y-%m-%d'
       ) AS day`,
    );
    const streak = computeStreaks(
      dayRows.map((r) => readRow(r, 'digest-days').str('day')).filter(Boolean),
      readRow(todayRows[0] ?? {}, 'digest-today').str('day'),
    );

    // Code impact over canonical file_edits (session-atomic, like everything else).
    const impactTotalsRaw = await queryRows(
      conn,
      `${scopedCte}
       SELECT COALESCE(sum(fe.additions), 0) AS additions, COALESCE(sum(fe.deletions), 0) AS deletions,
              count(*) AS edits, count(DISTINCT fe.file_path) AS files_touched
       FROM file_edits fe JOIN scoped s ON s.id = fe.session_id
       WHERE fe.edit_canonical`,
    );
    const impactFilesRaw = await queryRows(
      conn,
      `${scopedCte}
       SELECT fe.file_path AS path, sum(fe.additions) AS additions, sum(fe.deletions) AS deletions
       FROM file_edits fe JOIN scoped s ON s.id = fe.session_id
       WHERE fe.edit_canonical
       GROUP BY fe.file_path
       ORDER BY sum(fe.additions) + sum(fe.deletions) DESC, fe.file_path
       LIMIT ${TOP_LIMIT}`,
    );
    const imd = readRow(impactTotalsRaw[0] ?? {}, 'digest-impact');
    const impact = {
      additions: imd.num('additions'),
      deletions: imd.num('deletions'),
      edits: imd.num('edits'),
      filesTouched: imd.num('files_touched'),
      topFiles: impactFilesRaw.map((r) => {
        const rd = readRow(r, 'digest-impact-files');
        return { path: rd.str('path'), additions: rd.num('additions'), deletions: rd.num('deletions') };
      }),
    };

    // Reliability — roll up the shared per-agent aggregation. Agents whose
    // formats carry no error signal are listed, not zero-counted.
    const signals = await errorSignalsByAgent(conn, { from, to, timeZone });
    const known = signals.filter((s) => s.toolErrors !== null);
    const errors: DigestErrors | null = known.length
      ? {
          toolCalls: known.reduce((acc, s) => acc + s.toolCalls, 0),
          toolErrors: known.reduce((acc, s) => acc + (s.toolErrors ?? 0), 0),
          errorRate: (() => {
            const calls = known.reduce((acc, s) => acc + s.toolCalls, 0);
            return calls > 0 ? known.reduce((acc, s) => acc + (s.toolErrors ?? 0), 0) / calls : null;
          })(),
          unknownAgents: signals
            .filter((s) => s.toolErrors === null && s.toolCalls > 0)
            .map((s) => s.connectorId),
        }
      : null;
    const interrupting = signals.find((s) => hasInterruptSignal(s.connectorId));
    const interrupts = interrupting ? interrupting.interrupts : null;

    return {
      from,
      to,
      totals: {
        sessions,
        activeProjects: td.num('projects'),
        responses: readRow(responsesRaw[0] ?? {}, 'digest-responses').num('responses'),
        totalTokens: td.num('tokens'),
        costUsd: td.num('cost'),
      },
      topProjects,
      models,
      topTools,
      agents,
      biggestSession,
      streak,
      impact,
      errors,
      interrupts,
    };
  });
}
