/**
 * Shared scope resolution for the analytics routes: every one of them narrows
 * to "sessions in scope" the same way — an optional project (slug id resolved
 * against `sessions.project_cwd`, like /api/sessions) plus inclusive date
 * bounds on the session start. Centralised here so the slug-resolution loop
 * and the bound semantics can't drift between routes.
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import { queryRows, sqlString } from '../db/duckdb.js';
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
 * SQL filter conditions for the scope. The project slug is resolved to its
 * cwd by scanning the distinct `project_cwd` values (same resolution
 * /api/sessions uses); an unknown slug yields a never-matching condition so
 * a bad param returns empty rather than everything.
 */
export async function scopeFilters(
  conn: DuckDBConnection,
  scope: AnalyticsScope,
  cols: ScopeColumns = {},
): Promise<string[]> {
  const cwdCol = cols.cwd ?? 'project_cwd';
  const tsCol = cols.ts ?? 'started_at';
  const filters: string[] = [];
  if (scope.project) {
    const cwds = await queryRows(
      conn,
      'SELECT DISTINCT project_cwd FROM sessions WHERE project_cwd IS NOT NULL',
    );
    const match = cwds
      .map((c) => String(c.project_cwd))
      .find((c) => projectIdFromCwd(c) === scope.project);
    filters.push(`${cwdCol} = ${match ? sqlString(match) : "'\\0'"}`);
  }
  if (scope.from) filters.push(`${tsCol} >= ${sqlString(scope.from)}::TIMESTAMP`);
  if (scope.to) filters.push(`${tsCol} <= ${sqlString(scope.to)}::TIMESTAMP`);
  return filters;
}
