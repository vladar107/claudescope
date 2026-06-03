/**
 * GET /api/sessions — list sessions with optional project filter, sort, and a
 * lightweight title/text query (`q`).
 *
 * GET /api/sessions/:id — full session detail: derived meta + the assembled
 * thread (parsed directly from the session's JSONL on disk).
 */

import type { FastifyInstance } from 'fastify';
import type {
  SessionDetailResponse,
  SessionMeta,
  SessionSort,
} from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { projectIdFromCwd } from '../data/project-id.js';
import { toIso } from './projects.js';
import { assembleThread, buildSubagentRuns } from '../data/parser.js';
import { loadSessionData } from '../data/session-loader.js';

const SORT_SQL: Record<SessionSort, string> = {
  recent: 'ended_at DESC NULLS LAST',
  oldest: 'started_at ASC NULLS LAST',
  tokens: 'total_tokens DESC',
  cost: 'total_cost_usd DESC',
  messages: 'message_count DESC',
};

function rowToSessionMeta(r: Record<string, unknown>): SessionMeta {
  const cwd = r.project_cwd != null ? String(r.project_cwd) : '';
  const modelsStr = r.models != null ? String(r.models) : '';
  const meta: SessionMeta = {
    id: String(r.id),
    projectId: cwd ? projectIdFromCwd(cwd) : '',
    title: r.title != null ? String(r.title) : '',
    startedAt: toIso(r.started_at),
    endedAt: toIso(r.ended_at),
    messageCount: Number(r.message_count ?? 0),
    toolCallCount: Number(r.tool_call_count ?? 0),
    totalTokens: Number(r.total_tokens ?? 0),
    totalCostUsd: Number(r.total_cost_usd ?? 0),
    models: modelsStr ? modelsStr.split(',').filter(Boolean) : [],
    sizeBytes: Number(r.size_bytes ?? 0),
    hasSidechain: Boolean(r.has_sidechain),
  };
  if (r.git_branch != null && String(r.git_branch).length > 0) {
    meta.gitBranch = String(r.git_branch);
  }
  if (r.pr_url != null && String(r.pr_url).length > 0) {
    meta.prUrl = String(r.pr_url);
  }
  return meta;
}

export async function registerSessionsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { project?: string; sort?: string; q?: string };
  }>('/api/sessions', async (req): Promise<SessionMeta[]> => {
    const conn = await getConnection();
    const { project, sort, q } = req.query;

    const where: string[] = [];
    if (project) {
      // project is the slug id; match against the slug of project_cwd.
      // We resolve the cwd by scanning distinct cwds (small set).
      const cwds = await queryRows(
        conn,
        'SELECT DISTINCT project_cwd FROM sessions WHERE project_cwd IS NOT NULL',
      );
      const match = cwds
        .map((c) => String(c.project_cwd))
        .find((c) => projectIdFromCwd(c) === project);
      where.push(`project_cwd = ${match ? sqlString(match) : "'\\0'"}`);
    }
    if (q && q.trim()) {
      where.push(`(lower(title) LIKE ${sqlString('%' + q.toLowerCase() + '%')})`);
    }

    const sortKey: SessionSort = (sort as SessionSort) in SORT_SQL ? (sort as SessionSort) : 'recent';
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await queryRows(
      conn,
      `SELECT * FROM sessions ${whereSql} ORDER BY ${SORT_SQL[sortKey]}`,
    );
    return rows.map(rowToSessionMeta);
  });

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id',
    async (req, reply): Promise<SessionDetailResponse | void> => {
      const conn = await getConnection();
      const id = req.params.id;

      const rows = await queryRows(
        conn,
        `SELECT * FROM sessions WHERE id = ${sqlString(id)}`,
      );
      if (rows.length === 0) {
        reply.code(404).send({ error: 'Session not found' });
        return;
      }
      const meta = rowToSessionMeta(rows[0] as Record<string, unknown>);

      const { mainEvents, subagents: subagentSources } = await loadSessionData(id);
      const thread = assembleThread(mainEvents);
      const subagents = buildSubagentRuns(thread, subagentSources);

      return { meta, thread, subagents };
    },
  );
}
