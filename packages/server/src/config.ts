/** Centralized server configuration constants. */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** TCP port the Fastify server listens on. Override with PORT. */
export const PORT = Number(process.env.PORT ?? 4317);

/** Root directory of the server package (resolved from dist or src at runtime). */
export const PACKAGE_ROOT = join(__dirname, '..');

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * READ-ONLY source of session data. The app MUST NEVER write here.
 *
 * Defaults to `~/.claude/projects`. Override with the CLAUDE_PROJECTS_DIR
 * environment variable to point at a different location (e.g. a copy of
 * transcripts exported from another machine). A leading `~` is expanded.
 */
export const CLAUDE_PROJECTS_DIR = expandHome(
  process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects'),
);

/** Whether to auto-open the default browser on startup (set by the launcher). */
export const OPEN_BROWSER = process.env.OPEN_BROWSER === '1';

/**
 * How often (ms) to auto-reindex so live/new sessions show up without a
 * restart. Each poll just stats files and bails when nothing changed, so the
 * cost is negligible. Set REINDEX_INTERVAL_MS=0 to disable. Default 15s.
 */
export const REINDEX_INTERVAL_MS = Number(process.env.REINDEX_INTERVAL_MS ?? 15000);

/**
 * Persistent DuckDB index file. Owned by this app; safe to recreate. Override
 * with DUCKDB_PATH (used by tests to point at a throwaway temp database).
 */
export const DUCKDB_PATH = process.env.DUCKDB_PATH ?? join(PACKAGE_ROOT, 'data', 'index.duckdb');

/** User-editable pricing config. */
export const PRICING_PATH = join(PACKAGE_ROOT, 'pricing.json');

/** Built web assets served in production (`npm start`). */
export const WEB_DIST_DIR = join(PACKAGE_ROOT, '..', 'web', 'dist');

export const APP_VERSION = '0.1.0';
