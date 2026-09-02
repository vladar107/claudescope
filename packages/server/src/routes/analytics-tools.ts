/**
 * GET /api/analytics/tools — count of tool calls by raw (canonical) tool name
 * AND the agent that emitted it (joined from `sessions.connector_id`), descending.
 * Unnests the `events.tool_names` CSV. Duplicates are dropped by excluding fork
 * copies (`forked_from_session_id`, set on every copied row), NOT by
 * `usage_canonical`: that elects one row per billed message for token sums, while
 * a split message keeps its tool_use blocks on specific rows — most of which lose
 * the election, so filtering on it hides the majority of real calls. The web maps
 * raw names → categories via `toolCategory()` and surfaces the per-agent
 * attribution in the tooltip.
 *
 * `kind=skill` swaps the source column to `events.skill_names` — the `skill`
 * argument of each canonical `Skill` tool_use call — so the same `tool` field
 * carries a skill name instead of a tool name.
 */
import type { FastifyInstance } from 'fastify';
import type { ToolUsageKind, ToolUsageResponse, ToolUsageRow } from '@claudescope/shared';
import { getConnection, queryRows } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { scopeFilters } from '../data/analytics-scope.js';
import { enumParam } from '../params.js';

const TOOL_USAGE_KINDS = ['tool', 'skill'] as const;

export async function registerToolsRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { kind?: string; project?: string; from?: string; to?: string; timeZone?: string };
  }>('/api/analytics/tools', async (req): Promise<ToolUsageResponse> => {
    const conn = await getConnection();
    const kind: ToolUsageKind = enumParam(req.query.kind, 'kind', TOOL_USAGE_KINDS, 'tool');
    const column = kind === 'skill' ? 'skill_names' : 'tool_names';
    const filters: string[] = [
      "e.type = 'assistant'",
      'e.forked_from_session_id IS NULL',
      `e.${column} <> ''`,
    ];
    // Project scope resolves like every other analytics route; date bounds stay
    // on the event timestamp (a call belongs to the day it happened).
    filters.push(...(await scopeFilters(conn, req.query, { cwd: 's.project_cwd', ts: 'e.ts' })));

    const rows = await queryRows(
      conn,
      `SELECT tool, agent, count(*) AS count
       FROM (
         SELECT unnest(string_split(e.${column}, ',')) AS tool, s.connector_id AS agent
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
