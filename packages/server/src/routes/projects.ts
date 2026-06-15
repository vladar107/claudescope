/**
 * GET /api/projects — aggregate session metadata per distinct real `cwd`.
 *
 * Projects are grouped by `sessions.project_cwd` (the modal cwd of each
 * session's events), so the (lossy) encoded directory name is never used for
 * identity. Token totals exclude nothing; cost is summed from per-event cost.
 */

import type { FastifyInstance } from 'fastify';
import type { AgentBreakdown, ProjectMeta } from '@claudescope/shared';
import { getConnection, queryRows } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
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
         max(ended_at) AS last_active
       FROM sessions
       WHERE project_cwd IS NOT NULL
       GROUP BY project_cwd
       ORDER BY last_active DESC NULLS LAST`,
    );

    // Per-agent slices, fetched as flat rows and grouped by cwd below (simpler
    // and more portable than nested struct aggregation).
    const agentRows = await queryRows(
      conn,
      `SELECT
         project_cwd AS cwd,
         connector_id,
         count(*) AS session_count,
         sum(total_tokens) AS total_tokens,
         sum(total_cost_usd) AS total_cost_usd
       FROM sessions
       WHERE project_cwd IS NOT NULL AND connector_id IS NOT NULL
       GROUP BY project_cwd, connector_id
       ORDER BY sum(total_tokens) DESC`,
    );

    const agentsByCwd = new Map<string, AgentBreakdown[]>();
    for (const r of agentRows) {
      const rd = readRow(r, 'projects.agents');
      const cwd = rd.str('cwd');
      const list = agentsByCwd.get(cwd) ?? [];
      list.push({
        connectorId: rd.str('connector_id'),
        sessionCount: rd.num('session_count'),
        totalTokens: rd.num('total_tokens'),
        totalCostUsd: rd.num('total_cost_usd'),
      });
      agentsByCwd.set(cwd, list);
    }

    return rows.map((r): ProjectMeta => {
      const rd = readRow(r, 'projects');
      const cwd = rd.str('cwd');
      const agents = agentsByCwd.get(cwd) ?? [];
      return {
        id: projectIdFromCwd(cwd),
        cwd,
        displayName: displayNameFromCwd(cwd),
        sessionCount: rd.num('session_count'),
        totalTokens: rd.num('total_tokens'),
        totalCostUsd: rd.num('total_cost_usd'),
        lastActive: toIso(rd.req('last_active')),
        connectorIds: agents.map((a) => a.connectorId),
        agents,
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
