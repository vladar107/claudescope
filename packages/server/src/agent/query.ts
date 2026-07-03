/**
 * CLI query subcommands (`claudescope search|sessions|session|projects|analytics`)
 * — read-only lookups against the daemon's HTTP API for terminals and scripts.
 *
 * Each command returns the string to print: an aligned table / compact Markdown
 * for humans, or the raw API response as JSON with `--json` (machine-readable;
 * ignores `--redact` and does no shaping). Daemon startup progress goes to
 * stderr (ensureDaemon), so stdout stays clean for piping.
 */

import type { AnalyticsGroupBy, SearchScope, SearchType, SessionSort } from '@claudescope/shared';
import type { ApiClient } from './api-client.js';
import {
  DEFAULT_LIMIT,
  DEFAULT_MAX_TOOL_CHARS,
  DEFAULT_TURNS,
  day,
  fmtCost,
  fmtTokens,
  shapeSearchResults,
  shapeSessionMarkdown,
} from './shape.js';

const json = (v: unknown): string => JSON.stringify(v, null, 2);

/** Cap for free-text columns (titles, cwds) so one long value can't blow up the table. */
const MAX_CELL = 60;

const clip = (s: string): string => (s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s);

/**
 * Dependency-free aligned table: pad each column to its widest cell (header
 * included); `right` marks numeric columns for right-alignment. Widths are
 * code-unit based — good enough for a terminal listing.
 */
export function table(headers: string[], rows: string[][], right: boolean[] = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (right[i] ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export interface SearchArgs {
  query: string;
  project?: string;
  role?: SearchType;
  scope?: SearchScope;
  limit?: number;
  json?: boolean;
}

export async function querySearch(client: ApiClient, args: SearchArgs): Promise<string> {
  const res = await client.search({
    q: args.query,
    project: args.project,
    type: args.role ?? 'all',
    scope: args.scope ?? 'sessions',
    format: 'plain',
  });
  if (args.json) return json(res);
  return shapeSearchResults(res, args.limit ?? DEFAULT_LIMIT);
}

export interface SessionsArgs {
  project?: string;
  agent?: string;
  sort?: SessionSort;
  q?: string;
  limit?: number;
  json?: boolean;
}

export async function querySessions(client: ApiClient, args: SessionsArgs): Promise<string> {
  const rows = await client.sessions({ ...args, limit: args.limit ?? DEFAULT_LIMIT });
  if (args.json) return json(rows);
  if (rows.length === 0) return 'No sessions match.';
  return table(
    ['ID', 'AGENT', 'TITLE', 'DATE', 'MSGS', 'TOKENS', 'COST'],
    rows.map((s) => [
      s.id,
      s.connectorId,
      clip(s.title),
      day(s.startedAt),
      String(s.messageCount),
      fmtTokens(s.totalTokens),
      fmtCost(s.totalCostUsd),
    ]),
    [false, false, false, false, true, true, true],
  );
}

export interface SessionArgs {
  offset?: number;
  limit?: number;
  around?: string;
  radius?: number;
  maxToolChars?: number;
  redact?: boolean;
  json?: boolean;
}

export async function querySession(client: ApiClient, id: string, args: SessionArgs): Promise<string> {
  // Same defaulting as the MCP get_session tool: no windowing params → the
  // first DEFAULT_TURNS turns, so a huge session never dumps whole.
  const windowed =
    args.around === undefined && args.offset === undefined && args.limit === undefined
      ? { offset: 0, limit: DEFAULT_TURNS }
      : { offset: args.offset, limit: args.limit, around: args.around, radius: args.radius };
  const data = await client.session(id, {
    ...windowed,
    maxToolChars: args.maxToolChars ?? DEFAULT_MAX_TOOL_CHARS,
  });
  if (args.json) return json(data);
  return shapeSessionMarkdown(data, args.redact ?? false);
}

export async function queryProjects(client: ApiClient, args: { json?: boolean }): Promise<string> {
  const rows = await client.projects();
  if (args.json) return json(rows);
  if (rows.length === 0) return 'No projects indexed.';
  return table(
    ['ID', 'PATH', 'SESSIONS', 'TOKENS', 'COST', 'AGENTS', 'LAST ACTIVE'],
    rows.map((p) => [
      p.id,
      clip(p.cwd),
      String(p.sessionCount),
      fmtTokens(p.totalTokens),
      fmtCost(p.totalCostUsd),
      p.connectorIds.join(','),
      day(p.lastActive),
    ]),
    [false, false, true, true, true, false, false],
  );
}

export interface AnalyticsArgs {
  groupBy?: AnalyticsGroupBy;
  from?: string;
  to?: string;
  json?: boolean;
}

export async function queryAnalytics(client: ApiClient, args: AnalyticsArgs): Promise<string> {
  const res = await client.analytics({ groupBy: args.groupBy ?? 'project', from: args.from, to: args.to });
  if (args.json) return json(res);
  if (res.rows.length === 0) return 'No usage in range.';
  const t = res.totals;
  return (
    table(
      ['KEY', 'TOKENS', 'IN', 'OUT', 'COST', 'RESPONSES'],
      res.rows.map((r) => [
        clip(r.key),
        fmtTokens(r.totalTokens),
        fmtTokens(r.inputTokens),
        fmtTokens(r.outputTokens),
        fmtCost(r.costUsd),
        String(r.messageCount),
      ]),
      [false, true, true, true, true, true],
    ) +
    `\n\nTotal: ${fmtTokens(t.totalTokens)} tok · ${fmtCost(t.costUsd)} · ${t.messageCount} responses · ` +
    `cache hit ${(t.cacheHitRatio * 100).toFixed(0)}%`
  );
}
