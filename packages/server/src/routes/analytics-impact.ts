/**
 * GET /api/analytics/impact — code-impact aggregation over `file_edits`
 * (LOC added/removed, files touched, edit-call counts), grouped by agent, day,
 * or file, with optional project + inclusive date bounds.
 *
 * The metric is agent-reported churn from canonical Edit/MultiEdit/Write tool
 * calls — not git truth (reverted/overwritten edits count each time). Rows are
 * already deduplicated across fork/resume copies at index time
 * (`edit_canonical` — see data/file-edits.ts), so plain SUMs are safe. Every
 * connector maps its edits to the canonical tools, so unlike token metrics this
 * comparison is fair across all agents.
 *
 * Date bounds filter on the edit's own timestamp, falling back to the session
 * start for formats whose tool calls carry no timestamp.
 */

import type { FastifyInstance } from 'fastify';
import type { ImpactGroupBy, ImpactResponse, ImpactRow, ImpactTotals } from '@claudescope/shared';
import { getConnection, queryRows } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import {
  analyticsTimeZone,
  localTimestampSql,
  scopeFilters,
} from '../data/analytics-scope.js';

/** Cap for `groupBy=file` — the long tail of one-touch files isn't informative. */
const FILE_ROW_LIMIT = 200;

function keyExpr(groupBy: ImpactGroupBy, timeZone: string): string {
  switch (groupBy) {
    case 'day':
      return `strftime(${localTimestampSql('COALESCE(fe.ts, s.started_at)', timeZone)}, '%Y-%m-%d')`;
    case 'file':
      return 'fe.file_path';
    case 'agent':
    default:
      return "COALESCE(s.connector_id, 'unknown')";
  }
}

export async function registerImpactRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      groupBy?: string;
      project?: string;
      from?: string;
      to?: string;
      timeZone?: string;
    };
  }>('/api/analytics/impact', async (req): Promise<ImpactResponse> => {
    const conn = await getConnection();
    const timeZone = await analyticsTimeZone(conn, req.query.timeZone);
    const groupBy: ImpactGroupBy = ['agent', 'day', 'file'].includes(req.query.groupBy ?? '')
      ? (req.query.groupBy as ImpactGroupBy)
      : 'agent';

    const tsExpr = 'COALESCE(fe.ts, s.started_at)';
    const filters = [
      'fe.edit_canonical',
      ...(await scopeFilters(conn, req.query, { cwd: 's.project_cwd', ts: tsExpr })),
    ];

    const baseSql = `
      FROM file_edits fe
      JOIN sessions s ON s.id = fe.session_id
      WHERE ${filters.join(' AND ')}`;

    const limitSql = groupBy === 'file' ? ` LIMIT ${FILE_ROW_LIMIT}` : '';
    const rowsRaw = await queryRows(
      conn,
      `SELECT
         ${keyExpr(groupBy, timeZone)} AS group_key,
         sum(fe.additions) AS additions,
         sum(fe.deletions) AS deletions,
         count(*) AS edits,
         count(DISTINCT fe.file_path) AS files_touched,
         count(DISTINCT fe.session_id) AS sessions
       ${baseSql}
       GROUP BY group_key
       ORDER BY sum(fe.additions) + sum(fe.deletions) DESC, group_key${limitSql}`,
    );

    const rows: ImpactRow[] = rowsRaw.map((r) => {
      const rd = readRow(r, 'analytics-impact');
      return {
        key: rd.str('group_key', 'unknown'),
        additions: rd.num('additions'),
        deletions: rd.num('deletions'),
        edits: rd.num('edits'),
        filesTouched: rd.num('files_touched'),
        sessions: rd.num('sessions'),
      };
    });

    const totalRaw = await queryRows(
      conn,
      `SELECT
         COALESCE(sum(fe.additions), 0) AS additions,
         COALESCE(sum(fe.deletions), 0) AS deletions,
         count(*) AS edits,
         count(DISTINCT fe.file_path) AS files_touched,
         count(DISTINCT fe.session_id) AS sessions
       ${baseSql}`,
    );
    const td = readRow(totalRaw[0] ?? {}, 'analytics-impact-totals');
    const totals: ImpactTotals = {
      additions: td.num('additions'),
      deletions: td.num('deletions'),
      edits: td.num('edits'),
      filesTouched: td.num('files_touched'),
      sessions: td.num('sessions'),
    };

    return { rows, totals };
  });
}
