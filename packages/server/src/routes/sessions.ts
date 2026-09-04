/**
 * GET /api/sessions — list sessions with optional project filter, sort, and a
 * lightweight title/text query (`q`).
 *
 * GET /api/sessions/:id — full session detail: derived meta + the assembled
 * thread (parsed directly from the session's JSONL on disk).
 *
 * GET /api/sessions/:id/fingerprint — live change probe for the session page's
 * auto-refresh poller (stats the session's files; never triggers a reindex).
 */

import type { FastifyInstance } from 'fastify';
import type {
  SessionDetailResponse,
  SessionFingerprintResponse,
  SessionMeta,
  SessionSort,
} from '@claudescope/shared';
import { isZeroRated } from '@claudescope/shared';
import { getConnection, queryRows, sqlLikeEscape, sqlString } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { displayNameFromCwd, projectIdFromCwd } from '../data/project-id.js';
import { projectFilter } from '../data/analytics-scope.js';
import { BadRequestError } from '../params.js';
import { toIso } from './projects.js';
import { assembleThread, buildSubagentRuns } from '../data/parser.js';
import { loadSessionData } from '../data/session-loader.js';
import { computeSessionFingerprint } from '../data/fingerprint.js';
import { contextWindowFor, loadPricing } from '../data/pricing.js';
import { hasCompactionSignal, hasPromptSizedUsage } from '../data/agent-capabilities.js';
import { connectorById } from '../connectors/registry.js';
import { buildResumeInfo } from '../connectors/resume.js';
import { resolveWindow, subagentsInWindow, truncateToolChars } from '../data/window.js';

/** Parse a non-negative integer query param; undefined for anything else. */
function intParam(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const SORT_SQL: Record<SessionSort, string> = {
  recent: 'ended_at DESC NULLS LAST',
  oldest: 'started_at ASC NULLS LAST',
  tokens: 'total_tokens DESC',
  cost: 'total_cost_usd DESC',
  messages: 'message_count DESC',
  context: 'context_tokens DESC NULLS LAST',
};

function rowToSessionMeta(r: Record<string, unknown>): SessionMeta {
  const rd = readRow(r, 'sessions');
  const cwd = rd.str('project_cwd');
  const modelsStr = rd.str('models');
  const providersStr = rd.str('providers');
  const providers = providersStr ? providersStr.split(',').filter(Boolean) : [];
  const pricing = loadPricing();
  const hasLocalProvider = providers.some((p) => {
    const rates = pricing.providers?.[p.toLowerCase()];
    return rates !== undefined && isZeroRated(rates);
  });
  const connectorId = rd.str('connector_id') || 'claude-code';
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
    providers,
    sizeBytes: rd.num('size_bytes'),
    hasSidechain: rd.bool('has_sidechain'),
    connectorId,
  };
  if (hasLocalProvider) meta.hasLocalProvider = true;
  // Context/compactions read "unavailable" (absent) for agents whose format
  // never records them — a property of the connector, not of this session.
  if (hasPromptSizedUsage(connectorId) && rd.req('context_tokens') != null) {
    meta.contextTokens = rd.num('context_tokens');
    const window = contextWindowFor(rd.str('context_model'), pricing);
    if (window !== undefined) meta.contextWindow = window;
  }
  if (hasCompactionSignal(connectorId)) meta.compactionCount = rd.num('compaction_count');
  if (rd.bool('title_derived')) meta.titleDerived = true;
  const gitBranch = rd.str('git_branch');
  if (gitBranch) meta.gitBranch = gitBranch;
  const prUrl = rd.str('pr_url');
  if (prUrl) meta.prUrl = prUrl;
  return meta;
}

export async function registerSessionsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      project?: string;
      sort?: string;
      q?: string;
      agent?: string;
      branch?: string;
      limit?: string;
    };
  }>('/api/sessions', async (req): Promise<SessionMeta[]> => {
    const conn = await getConnection();
    const { project, sort, q, agent, branch } = req.query;
    const limit = intParam(req.query.limit);

    const where: string[] = [];
    if (agent) {
      where.push(`connector_id = ${sqlString(agent)}`);
    }
    if (branch) {
      where.push(`git_branch = ${sqlString(branch)}`);
    }
    // `project` is the slug id; resolution + the unknown-slug sentinel are shared
    // with /api/search and the analytics routes.
    if (project) where.push(await projectFilter(conn, project));
    if (q && q.trim()) {
      where.push(
        `(lower(title) LIKE ${sqlString('%' + sqlLikeEscape(q.toLowerCase()) + '%')} ESCAPE '\\')`,
      );
    }

    // Object.hasOwn, NOT `in`: `in` walks Object.prototype, so ?sort=toString
    // passed the gate and interpolated a Function into ORDER BY (a 500 quoting
    // the generated SQL). Unknown values still fall back to the default.
    const sortKey: SessionSort = Object.hasOwn(SORT_SQL, sort ?? '')
      ? (sort as SessionSort)
      : 'recent';
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const limitSql = limit !== undefined && limit > 0 ? ` LIMIT ${limit}` : '';
    const rows = await queryRows(
      conn,
      `SELECT * FROM sessions ${whereSql} ORDER BY ${SORT_SQL[sortKey]}${limitSql}`,
    );
    return rows.map(rowToSessionMeta);
  });

  // Lightweight live-change probe for the session page's auto-refresh poller.
  // Stats the session's files per request (read-only; never triggers a reindex).
  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/fingerprint',
    async (req, reply): Promise<SessionFingerprintResponse | void> => {
      const fp = await computeSessionFingerprint(req.params.id);
      if (!fp) {
        reply.code(404).send({ error: 'Session not found' });
        return;
      }
      return fp;
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: {
      offset?: string;
      limit?: string;
      around?: string;
      radius?: string;
      tail?: string;
      maxToolChars?: string;
    };
  }>(
    '/api/sessions/:id',
    async (req, reply): Promise<SessionDetailResponse | void> => {
      const conn = await getConnection();
      const id = req.params.id;

      // Windowing/truncation for token-frugal consumers (MCP/CLI). Parsed and
      // validated before the session is loaded — a malformed request must not
      // pay for a full parse. No params → the full session, byte-identical to
      // the pre-windowing behavior.
      const offset = intParam(req.query.offset);
      const limit = intParam(req.query.limit);
      const radius = intParam(req.query.radius);
      const tail = intParam(req.query.tail);
      const maxToolChars = intParam(req.query.maxToolChars);
      const around = req.query.around;
      if (tail !== undefined && (offset !== undefined || limit !== undefined || around !== undefined)) {
        throw new BadRequestError('tail cannot be combined with offset, limit, or around');
      }

      const rows = await queryRows(
        conn,
        `SELECT * FROM sessions WHERE id = ${sqlString(id)}`,
      );
      if (rows.length === 0) {
        reply.code(404).send({ error: 'Session not found' });
        return;
      }
      const row = rows[0] as Record<string, unknown>;
      const meta = rowToSessionMeta(row);

      const { mainEvents, subagents: subagentSources } = await loadSessionData(id);
      const assemble = { deriveContextSizes: hasPromptSizedUsage(meta.connectorId) };
      let thread = assembleThread(mainEvents, assemble);
      let subagents = buildSubagentRuns(thread, subagentSources, assemble);

      const cwd = readRow(row, 'sessions').str('project_cwd');
      const resume = buildResumeInfo(connectorById(meta.connectorId), id, cwd || null);

      const res: SessionDetailResponse = { meta, thread, subagents };

      if (offset !== undefined || limit !== undefined || around !== undefined || tail !== undefined) {
        const window = resolveWindow(thread, subagents, { offset, limit, around, radius, tail });
        thread = thread.slice(window.offset, window.offset + window.limit);
        subagents = subagentsInWindow(thread, subagents);
        res.window = window;
      }
      if (maxToolChars !== undefined && maxToolChars > 0) {
        thread = truncateToolChars(thread, maxToolChars);
        subagents = subagents.map((r) => ({ ...r, thread: truncateToolChars(r.thread, maxToolChars) }));
      }
      res.thread = thread;
      res.subagents = subagents;

      if (resume) res.resume = resume;
      return res;
    },
  );
}
