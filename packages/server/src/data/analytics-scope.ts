/**
 * Shared scope resolution for the analytics routes: every one of them narrows
 * to "sessions in scope" the same way — an optional project (slug id resolved
 * against `sessions.project_cwd`, like /api/sessions) plus inclusive date
 * bounds on the session start. Centralised here so the slug-resolution loop
 * and the bound semantics can't drift between routes.
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import { queryRows, sqlString } from '../db/duckdb.js';
import { timestampParam } from '../params.js';
import { projectIdFromCwd } from './project-id.js';

export interface AnalyticsScope {
  /** Project slug id (from /api/projects); unknown slugs match nothing. */
  project?: string;
  /** Inclusive ISO bounds on the session start. */
  from?: string;
  to?: string;
}

/** Column names the filters apply to, qualified for the caller's query. */
export interface ScopeColumns {
  /** Default `project_cwd`. */
  cwd?: string;
  /** Default `started_at`; may be an expression. */
  ts?: string;
}

/**
 * A condition that matches nothing. Used when a project slug resolves to no cwd,
 * so an unknown param returns empty rather than everything. Standard SQL does not
 * process backslash escapes inside single quotes, so this is the literal
 * two-character string `\0` — which no real cwd can be.
 */
const NEVER_MATCHES = "'\\0'";

/**
 * Resolve a project slug id to the `project_cwd` it came from, or `null` when no
 * indexed session matches.
 *
 * Slugs are hashed from the cwd (see `projectIdFromCwd`), so there is no inverse
 * — the resolution is a scan of the distinct cwds. Cheap: the set is one row per
 * project, and the alternative (storing the slug) would duplicate derivable state.
 */
export async function resolveProjectCwd(
  conn: DuckDBConnection,
  projectId: string,
): Promise<string | null> {
  const cwds = await queryRows(
    conn,
    'SELECT DISTINCT project_cwd FROM sessions WHERE project_cwd IS NOT NULL',
  );
  return cwds.map((c) => String(c.project_cwd)).find((c) => projectIdFromCwd(c) === projectId) ?? null;
}

/**
 * SQL condition restricting `cwdCol` to one project slug.
 *
 * Shared with the routes that filter by project but have no date scope
 * (/api/sessions, /api/search) — they each had their own copy of the resolution
 * loop AND of the never-match sentinel, so all three could drift.
 */
export async function projectFilter(
  conn: DuckDBConnection,
  projectId: string,
  cwdCol = 'project_cwd',
): Promise<string> {
  const match = await resolveProjectCwd(conn, projectId);
  return `${cwdCol} = ${match ? sqlString(match) : NEVER_MATCHES}`;
}

/**
 * SQL filter conditions for the scope. The project slug is resolved to its
 * cwd by scanning the distinct `project_cwd` values (same resolution
 * /api/sessions uses); an unknown slug yields a never-matching condition so
 * a bad param returns empty rather than everything.
 *
 * The date bounds are VALIDATED here rather than at each route. This is the one
 * chokepoint every bounded endpoint passes through, so validating it covers all
 * of them — /api/analytics{,/sessions,/agents,/activity,/tools,/impact,/errors,
 * /digest} — and any future caller by construction. An unusable bound throws
 * {@link BadRequestError}, which the route layer maps to 400; previously it
 * reached DuckDB and surfaced as a 500 quoting the generated SQL.
 */
export async function scopeFilters(
  conn: DuckDBConnection,
  scope: AnalyticsScope,
  cols: ScopeColumns = {},
): Promise<string[]> {
  const cwdCol = cols.cwd ?? 'project_cwd';
  const tsCol = cols.ts ?? 'started_at';
  const from = timestampParam(scope.from, 'from');
  const to = timestampParam(scope.to, 'to');
  const filters: string[] = [];
  if (scope.project) filters.push(await projectFilter(conn, scope.project, cwdCol));
  if (from) filters.push(`${tsCol} >= ${sqlString(from)}::TIMESTAMP`);
  if (to) {
    filters.push(
      to.length === 10
        ? `${tsCol} < (${sqlString(to)}::TIMESTAMP + INTERVAL 1 DAY)`
        : `${tsCol} <= ${sqlString(to)}::TIMESTAMP`,
    );
  }
  return filters;
}
