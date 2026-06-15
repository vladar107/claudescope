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
import { readRow } from '../db/row.js';
import { displayNameFromCwd, projectIdFromCwd } from '../data/project-id.js';
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
  const rd = readRow(r, 'sessions');
  const cwd = rd.str('project_cwd');
  const modelsStr = rd.str('models');
  const meta: SessionMeta = {
    id: rd.str('id'),
    projectId: cwd ? projectIdFromCwd(cwd) : '',
    projectDisplayName: cwd ? displayNameFromCwd(cwd) : '',
    title: rd.str('title'),
    startedAt: toIso(rd.req('started_at')),
    endedAt: toIso(rd.req('ended_at')),
    messageCount: rd.num('message_count'),
    toolCallCount: rd.num('tool_call_count'),
    totalTokens: rd.num('total_tokens'),
    totalCostUsd: rd.num('total_cost_usd'),
    models: modelsStr ? modelsStr.split(',').filter(Boolean) : [],
    sizeBytes: rd.num('size_bytes'),
    hasSidechain: rd.bool('has_sidechain'),
    connectorId: rd.str('connector_id') || 'claude-code',
  };
  const gitBranch = rd.str('git_branch');
  if (gitBranch) meta.gitBranch = gitBranch;
  const prUrl = rd.str('pr_url');
  if (prUrl) meta.prUrl = prUrl;
  return meta;
}

export async function registerSessionsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { project?: string; sort?: string; q?: string; agent?: string };
  }>('/api/sessions', async (req): Promise<SessionMeta[]> => {
    const conn = await getConnection();
    const { project, sort, q, agent } = req.query;

    const where: string[] = [];
    if (agent) {
      where.push(`connector_id = ${sqlString(agent)}`);
    }
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
