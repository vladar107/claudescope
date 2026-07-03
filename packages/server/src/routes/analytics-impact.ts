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
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { projectIdFromCwd } from '../data/project-id.js';

/** Cap for `groupBy=file` — the long tail of one-touch files isn't informative. */
const FILE_ROW_LIMIT = 200;

function keyExpr(groupBy: ImpactGroupBy): string {
  switch (groupBy) {
    case 'day':
      return "strftime(COALESCE(fe.ts, s.started_at), '%Y-%m-%d')";
    case 'file':
      return 'fe.file_path';
    case 'agent':
    default:
      return "COALESCE(s.connector_id, 'unknown')";
  }
}

export async function registerImpactRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { groupBy?: string; project?: string; from?: string; to?: string };
  }>('/api/analytics/impact', async (req): Promise<ImpactResponse> => {
    const conn = await getConnection();
    const groupBy: ImpactGroupBy = ['agent', 'day', 'file'].includes(req.query.groupBy ?? '')
      ? (req.query.groupBy as ImpactGroupBy)
      : 'agent';

    const filters: string[] = ['fe.edit_canonical'];
    if (req.query.project) {
      // project is the slug id; resolve it against the sessions' project_cwd
      // (the same resolution /api/sessions uses).
      const cwds = await queryRows(
        conn,
        'SELECT DISTINCT project_cwd FROM sessions WHERE project_cwd IS NOT NULL',
      );
      const match = cwds
        .map((c) => String(c.project_cwd))
        .find((c) => projectIdFromCwd(c) === req.query.project);
      filters.push(`s.project_cwd = ${match ? sqlString(match) : "'\\0'"}`);
    }
    const tsExpr = 'COALESCE(fe.ts, s.started_at)';
    if (req.query.from) filters.push(`${tsExpr} >= ${sqlString(req.query.from)}::TIMESTAMP`);
    if (req.query.to) filters.push(`${tsExpr} <= ${sqlString(req.query.to)}::TIMESTAMP`);

    const baseSql = `
      FROM file_edits fe
      JOIN sessions s ON s.id = fe.session_id
      WHERE ${filters.join(' AND ')}`;

    const limitSql = groupBy === 'file' ? ` LIMIT ${FILE_ROW_LIMIT}` : '';
    const rowsRaw = await queryRows(
      conn,
      `SELECT
         ${keyExpr(groupBy)} AS group_key,
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
