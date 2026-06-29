/**
 * GET /api/analytics/tools — count of tool calls by raw (canonical) tool name,
 * descending. Unnests the `events.tool_names` CSV. Filters on `usage_canonical`
 * to match the "tool calls" semantics of the session-efficiency table (a fork
 * copy / multi-block split must not multiply-count a call). The web maps raw
 * names → categories via `toolCategory()`.
 */
import type { FastifyInstance } from 'fastify';
import type { ToolUsageResponse, ToolUsageRow } from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { readRow } from '../db/row.js';

export async function registerToolsRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { from?: string; to?: string };
  }>('/api/analytics/tools', async (req): Promise<ToolUsageResponse> => {
    const conn = await getConnection();
    const filters: string[] = ["e.type = 'assistant'", 'e.usage_canonical', "e.tool_names <> ''"];
    if (req.query.from) filters.push(`e.ts >= ${sqlString(req.query.from)}::TIMESTAMP`);
    if (req.query.to) filters.push(`e.ts <= ${sqlString(req.query.to)}::TIMESTAMP`);

    const rows = await queryRows(
      conn,
      `SELECT tool, count(*) AS count
       FROM (
         SELECT unnest(string_split(e.tool_names, ',')) AS tool
         FROM events e
         WHERE ${filters.join(' AND ')}
       ) t
       WHERE tool <> ''
       GROUP BY tool
       ORDER BY count DESC, tool`,
    );
    const result: ToolUsageRow[] = rows.map((r) => {
      const rd = readRow(r, 'analytics-tools');
      return { tool: rd.str('tool'), count: rd.num('count') };
    });
    return { rows: result };
  });
}
