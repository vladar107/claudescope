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
import { digestToMarkdown } from '@claudescope/shared';
import type { ApiClient } from './api-client.js';
import {
  DEFAULT_LIMIT,
  DEFAULT_MAX_TOOL_CHARS,
  analyticsTotalsLine,
  day,
  fmtCost,
  fmtTokens,
  projectIdForCwd,
  resolveWindowArgs,
  shapeSearchResults,
  shapeSessionMarkdown,
  shapeToolUsage,
  table,
} from './shape.js';

const json = (v: unknown): string => JSON.stringify(v, null, 2);

/** Machine-local IANA time zone for user-facing analytics, with a stable fallback. */
export function detectedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Cap for free-text columns (titles, cwds) so one long value can't blow up the table. */
const MAX_CELL = 60;

const clip = (s: string): string => (s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s);

export interface SearchArgs {
  query: string;
  project?: string;
  role?: SearchType;
  scope?: SearchScope;
  literal?: boolean;
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
    literal: args.literal,
  });
  if (args.json) return json(res);
  return shapeSearchResults(res, args.limit ?? DEFAULT_LIMIT);
}

export interface SessionsArgs {
  project?: string;
  /** Working directory to scope to; resolved locally to a project id. */
  cwd?: string;
  agent?: string;
  branch?: string;
  sort?: SessionSort;
  q?: string;
  limit?: number;
  offset?: number;
  json?: boolean;
}

export async function querySessions(client: ApiClient, args: SessionsArgs): Promise<string> {
  const project = args.project ?? (args.cwd ? projectIdForCwd(args.cwd) : undefined);
  const rows = await client.sessions({
    project,
    agent: args.agent,
    branch: args.branch,
    sort: args.sort,
    q: args.q,
    limit: args.limit ?? DEFAULT_LIMIT,
    offset: args.offset,
  });
  if (args.json) return json(rows);
  if (rows.length === 0) return 'No sessions match.';
  return table(
    ['ID', 'AGENT', 'BRANCH', 'TITLE', 'DATE', 'MSGS', 'TOKENS', 'COST'],
    rows.map((s) => [
      s.id,
      s.connectorId,
      s.gitBranch ?? '',
      clip(s.title),
      day(s.startedAt),
      String(s.messageCount),
      fmtTokens(s.totalTokens),
      fmtCost(s.totalCostUsd),
    ]),
    [false, false, false, false, false, true, true, true],
  );
}

export interface SessionArgs {
  offset?: number;
  limit?: number;
  around?: string;
  radius?: number;
  tail?: number;
  maxToolChars?: number;
  redact?: boolean;
  json?: boolean;
}

export async function querySession(client: ApiClient, id: string, args: SessionArgs): Promise<string> {
  const data = await client.session(id, {
    ...resolveWindowArgs(args),
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
  groupBy?: AnalyticsGroupBy | 'tool' | 'skill';
  project?: string;
  from?: string;
  to?: string;
  timeZone?: string;
  json?: boolean;
}

export async function queryAnalytics(client: ApiClient, args: AnalyticsArgs): Promise<string> {
  const groupBy = args.groupBy ?? 'project';
  if (groupBy === 'tool' || groupBy === 'skill') {
    const res = await client.toolUsage({
      kind: groupBy,
      project: args.project,
      from: args.from,
      to: args.to,
      timeZone: args.timeZone,
    });
    if (args.json) return json(res);
    return shapeToolUsage(res, groupBy);
  }

  const res = await client.analytics({
    groupBy,
    from: args.from,
    to: args.to,
    timeZone: args.timeZone,
  });
  if (args.json) return json(res);
  if (res.rows.length === 0) return 'No usage in range.';
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
    `\n\n${analyticsTotalsLine(res.totals)}`
  );
}

export interface DigestArgs {
  from?: string;
  to?: string;
  timeZone?: string;
  json?: boolean;
}

/** Week-in-review digest — the human output IS the shared Markdown renderer,
 *  so the CLI prints exactly what the web "Copy as Markdown" button copies. */
export async function queryDigest(client: ApiClient, args: DigestArgs): Promise<string> {
  const res = await client.digest({ from: args.from, to: args.to, timeZone: args.timeZone });
  if (args.json) return json(res);
  return digestToMarkdown(res).trimEnd();
}
