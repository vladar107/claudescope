/**
 * GET /api/projects — aggregate session metadata per distinct real `cwd`.
 *
 * Projects are grouped by `sessions.project_cwd` (the modal cwd of each
 * session's events), so the (lossy) encoded directory name is never used for
 * identity. Token totals exclude nothing; cost is summed from per-event cost.
 */

import type { FastifyInstance } from 'fastify';
import type { ProjectMeta } from '@claudescope/shared';
import { getConnection, queryRows } from '../db/duckdb.js';
import { displayNameFromCwd, projectIdFromCwd } from '../data/project-id.js';

export async function registerProjectsRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', async (): Promise<ProjectMeta[]> => {
    const conn = await getConnection();
    const rows = await queryRows(
      conn,
      `SELECT
         project_cwd AS cwd,
         count(*) AS session_count,
         sum(total_tokens) AS total_tokens,
         sum(total_cost_usd) AS total_cost_usd,
         max(ended_at) AS last_active,
         array_to_string(list_distinct(list(connector_id) FILTER (WHERE connector_id IS NOT NULL)), ',') AS connector_ids
       FROM sessions
       WHERE project_cwd IS NOT NULL
       GROUP BY project_cwd
       ORDER BY last_active DESC NULLS LAST`,
    );

    return rows.map((r): ProjectMeta => {
      const cwd = String(r.cwd);
      const connectorIdsStr = r.connector_ids != null ? String(r.connector_ids) : '';
      const connectorIds = connectorIdsStr ? connectorIdsStr.split(',').filter(Boolean) : [];
      return {
        id: projectIdFromCwd(cwd),
        cwd,
        displayName: displayNameFromCwd(cwd),
        sessionCount: Number(r.session_count ?? 0),
        totalTokens: Number(r.total_tokens ?? 0),
        totalCostUsd: Number(r.total_cost_usd ?? 0),
        lastActive: toIso(r.last_active),
        connectorIds,
      };
    });
  });
}

/** DuckDB TIMESTAMP values come back as Date or string; normalize to ISO. */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'toString' in value) {
    const s = String(value);
    // DuckDBTimestampValue stringifies as 'YYYY-MM-DD HH:MM:SS(.ffffff)'.
    const parsed = new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return s;
  }
  if (typeof value === 'string') return value;
  return '';
}
