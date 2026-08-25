/**
 * Shared scope resolution for the analytics routes: every one of them narrows
 * to "sessions in scope" the same way — an optional project (slug id resolved
 * against `sessions.project_cwd`, like /api/sessions) plus inclusive date
 * bounds on the session start. Centralised here so the slug-resolution loop
 * and the bound semantics can't drift between routes.
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import { queryRows, sqlString } from '../db/duckdb.js';
import { BadRequestError, timestampParam } from '../params.js';
import { projectIdFromCwd } from './project-id.js';

export interface AnalyticsScope {
  /** Project slug id (from /api/projects); unknown slugs match nothing. */
  project?: string;
  /** Inclusive ISO bounds on the session start. */
  from?: string;
  to?: string;
  /** IANA timezone for calendar bounds and local-day analytics. Defaults to UTC. */
  timeZone?: string;
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
const UTC = 'UTC';
const OFFSET_SUFFIX_RE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const validatedTimeZones = new Map<string, string>([[UTC.toLowerCase(), UTC]]);

/**
 * Resolve an optional analytics timezone to the canonical name DuckDB knows.
 * Validation deliberately uses DuckDB's timezone catalogue: those are the
 * identifiers the SQL conversion functions will accept, so Node and DuckDB
 * cannot disagree at runtime. Raw HTTP callers remain UTC by default.
 */
export async function analyticsTimeZone(
  conn: DuckDBConnection,
  raw: string | undefined,
): Promise<string> {
  const value = raw?.trim() || UTC;
  const cached = validatedTimeZones.get(value.toLowerCase());
  if (cached) return cached;

  const rows = await queryRows(
    conn,
    `SELECT name
     FROM pg_timezone_names()
     WHERE lower(name) = lower(${sqlString(value)})
     ORDER BY name
     LIMIT 1`,
  );
  const name = rows[0]?.name;
  if (typeof name !== 'string' || name === '') {
    throw new BadRequestError(`timeZone must be a recognized IANA timezone (got '${value}')`);
  }
  validatedTimeZones.set(value.toLowerCase(), name);
  return name;
}

/** Treat a UTC-naive stored timestamp as the instant it represents. */
export function utcInstantSql(timestampSql: string): string {
  return `timezone('UTC', ${timestampSql})`;
}

/** Convert a UTC-naive stored timestamp into local wall time for grouping. */
export function localTimestampSql(timestampSql: string, timeZone: string): string {
  return `timezone(${sqlString(timeZone)}, ${utcInstantSql(timestampSql)})`;
}

/**
 * Turn a validated analytics bound into an absolute instant.
 *
 * Offset-bearing timestamps already identify an instant. Date-only values and
 * offset-less timestamps are local wall times in `timeZone`; applying the zone
 * after the TIMESTAMP cast lets ICU select the correct DST offset for that day.
 */
export function analyticsBoundSql(value: string, timeZone: string): string {
  if (value.length > 10 && OFFSET_SUFFIX_RE.test(value)) {
    return `${sqlString(value)}::TIMESTAMPTZ`;
  }
  return `timezone(${sqlString(timeZone)}, ${sqlString(value)}::TIMESTAMP)`;
}

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
  const timeZone = await analyticsTimeZone(conn, scope.timeZone);
  const filters: string[] = [];
  if (scope.project) filters.push(await projectFilter(conn, scope.project, cwdCol));
  if (from) filters.push(`${utcInstantSql(tsCol)} >= ${analyticsBoundSql(from, timeZone)}`);
  if (to) {
    filters.push(
      to.length === 10
        ? `${utcInstantSql(tsCol)} < timezone(${sqlString(timeZone)}, ${sqlString(to)}::TIMESTAMP + INTERVAL 1 DAY)`
        : `${utcInstantSql(tsCol)} <= ${analyticsBoundSql(to, timeZone)}`,
    );
  }
  return filters;
}
