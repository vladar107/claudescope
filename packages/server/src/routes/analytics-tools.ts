/**
 * GET /api/analytics/tools — count of tool calls by raw (canonical) tool name
 * AND the agent that emitted it (joined from `sessions.connector_id`), descending.
 * Unnests the `events.tool_names` CSV. Filters on `usage_canonical` to match the
 * "tool calls" semantics of the session-efficiency table (a fork copy / multi-block
 * split must not multiply-count a call). The web maps raw names → categories via
 * `toolCategory()` and surfaces the per-agent attribution in the tooltip.
 */
import type { FastifyInstance } from 'fastify';
import type { ToolUsageResponse, ToolUsageRow } from '@claudescope/shared';
import { getConnection, queryRows } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { scopeFilters } from '../data/analytics-scope.js';

export async function registerToolsRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { project?: string; from?: string; to?: string; timeZone?: string };
  }>('/api/analytics/tools', async (req): Promise<ToolUsageResponse> => {
    const conn = await getConnection();
    const filters: string[] = ["e.type = 'assistant'", 'e.usage_canonical', "e.tool_names <> ''"];
    // Project scope resolves like every other analytics route; date bounds stay
    // on the event timestamp (a call belongs to the day it happened).
    filters.push(...(await scopeFilters(conn, req.query, { cwd: 's.project_cwd', ts: 'e.ts' })));

    const rows = await queryRows(
      conn,
      `SELECT tool, agent, count(*) AS count
       FROM (
         SELECT unnest(string_split(e.tool_names, ',')) AS tool, s.connector_id AS agent
         FROM events e
         JOIN sessions s ON e.session_id = s.id
         WHERE ${filters.join(' AND ')}
       ) t
       WHERE tool <> ''
       GROUP BY tool, agent
       ORDER BY count DESC, tool, agent`,
    );
    const result: ToolUsageRow[] = rows.map((r) => {
      const rd = readRow(r, 'analytics-tools');
      return { tool: rd.str('tool'), agent: rd.str('agent'), count: rd.num('count') };
    });
    return { rows: result };
  });
}
