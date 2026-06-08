/** Centralized server configuration constants. */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Return the first candidate path that exists, or `fallback` if none do. */
function firstExisting(candidates: string[], fallback: string): string {
  return candidates.find((p) => existsSync(p)) ?? fallback;
}

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
 * Per-user state directory. Owns everything the app writes (the derived index,
 * the user-editable pricing copy, and — once the CLI lands — the daemon PID and
 * logs). Lives outside the package dir so it survives reinstalls and upgrades,
 * which is what makes a globally-installed / npx'd build safe to update without
 * losing the index or the user's pricing edits. Override with CLAUDESCOPE_HOME.
 */
export const CLAUDESCOPE_HOME = expandHome(
  process.env.CLAUDESCOPE_HOME ?? join(homedir(), '.claudescope'),
);

/**
 * Persistent DuckDB index file. Owned by this app; safe to recreate. Override
 * with DUCKDB_PATH (used by tests to point at a throwaway temp database).
 */
export const DUCKDB_PATH = process.env.DUCKDB_PATH ?? join(CLAUDESCOPE_HOME, 'index.duckdb');

/**
 * Read-only pricing template shipped inside the package. Seeds the user copy on
 * first run and is the fallback when no user copy exists. Resolved for both the
 * bundled layout (`<pkg>/pricing.default.json` next to the bundle) and the dev
 * layout (`packages/server/pricing.json`).
 */
export const DEFAULT_PRICING_PATH = firstExisting(
  [join(__dirname, 'pricing.default.json'), join(PACKAGE_ROOT, 'pricing.json')],
  join(PACKAGE_ROOT, 'pricing.json'),
);

/** User-editable pricing config, seeded from {@link DEFAULT_PRICING_PATH}. */
export const PRICING_PATH = process.env.PRICING_PATH ?? join(CLAUDESCOPE_HOME, 'pricing.json');

/**
 * Built web assets served in production. Resolved for both the bundled layout
 * (`<pkg>/web` next to the server bundle) and the dev layout
 * (`packages/web/dist`). Override with WEB_DIST_DIR.
 */
export const WEB_DIST_DIR =
  process.env.WEB_DIST_DIR ??
  firstExisting(
    [join(__dirname, 'web'), join(PACKAGE_ROOT, '..', 'web', 'dist')],
    join(PACKAGE_ROOT, '..', 'web', 'dist'),
  );

export const APP_VERSION = '0.1.0';

/**
 * Create the state directory and seed the user-editable pricing file from the
 * shipped default if it doesn't exist yet. Idempotent; call once at boot.
 */
export function ensureStateDir(): void {
  mkdirSync(CLAUDESCOPE_HOME, { recursive: true });
  if (!existsSync(PRICING_PATH) && existsSync(DEFAULT_PRICING_PATH)) {
    copyFileSync(DEFAULT_PRICING_PATH, PRICING_PATH);
  }
}
