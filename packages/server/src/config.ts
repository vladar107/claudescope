/** Centralized server configuration constants. */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PricingConfig } from '@claudescope/shared';

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

/**
 * READ-ONLY source of OpenAI Codex CLI sessions. The app MUST NEVER write here.
 * Defaults to `~/.codex/sessions` (`rollout-*.jsonl` under `YYYY/MM/DD/`).
 * Override with CODEX_SESSIONS_DIR. A leading `~` is expanded.
 */
export const CODEX_SESSIONS_DIR = expandHome(
  process.env.CODEX_SESSIONS_DIR ?? join(homedir(), '.codex', 'sessions'),
);

/**
 * READ-ONLY source of JetBrains Junie sessions. The app MUST NEVER write here.
 * Defaults to `~/.junie/sessions` (`session-<id>/events.jsonl`, plus an
 * `index.jsonl` listing every session). Override with JUNIE_SESSIONS_DIR. A
 * leading `~` is expanded.
 */
export const JUNIE_SESSIONS_DIR = expandHome(
  process.env.JUNIE_SESSIONS_DIR ?? join(homedir(), '.junie', 'sessions'),
);

/**
 * READ-ONLY source of pi (`@earendil-works/pi-coding-agent`) sessions. The app
 * MUST NEVER write here. Defaults to `~/.pi/agent/sessions` (one
 * `<ts>_<uuid>.jsonl` per session, under a per-`cwd` directory). Override with
 * PI_SESSIONS_DIR. A leading `~` is expanded.
 */
export const PI_SESSIONS_DIR = expandHome(
  process.env.PI_SESSIONS_DIR ?? join(homedir(), '.pi', 'agent', 'sessions'),
);

/**
 * READ-ONLY agent home directories — the parents of the session/project dirs
 * above, where each agent keeps its memory (`CLAUDE.md`, `AGENTS.md`, the Codex
 * `memories/` tree). Derived from the dirs above so the env overrides carry
 * through. The app MUST NEVER write here. Memory is read **only** from these
 * home dirs — never from the user's project directories.
 */
export const CLAUDE_HOME = dirname(CLAUDE_PROJECTS_DIR);
export const CODEX_HOME = dirname(CODEX_SESSIONS_DIR);
export const JUNIE_HOME = dirname(JUNIE_SESSIONS_DIR);

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
 * App-owned snapshot of runtime-fetched rates (from LiteLLM). Stored alongside
 * the other app state so it survives index rebuilds, which discard the DuckDB
 * cache. Override with FETCHED_PRICING_PATH (used by tests to point at a
 * throwaway temp dir).
 */
export const FETCHED_PRICING_PATH =
  process.env.FETCHED_PRICING_PATH ?? join(CLAUDESCOPE_HOME, 'pricing.fetched.json');

/**
 * Source for runtime pricing refresh: LiteLLM's community-maintained,
 * machine-readable price table (raw GitHub, no auth). Override with
 * LITELLM_PRICING_URL.
 */
export const LITELLM_PRICING_URL =
  process.env.LITELLM_PRICING_URL ??
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * How often (ms) the daemon re-fetches pricing from LiteLLM. Set
 * PRICING_REFRESH_INTERVAL_MS=0 to disable. Default 24h. (The timer itself is
 * wired up in a later wave; this constant only declares the interval.)
 */
export const PRICING_REFRESH_INTERVAL_MS = Number(
  process.env.PRICING_REFRESH_INTERVAL_MS ?? 24 * 60 * 60 * 1000,
);

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

/**
 * App version. Injected at bundle time via esbuild `define` so it always tracks
 * the published package version (and the CLI's update check stays correct).
 * `typeof` keeps this safe in the dev build, where the define isn't applied.
 */
declare const __CLAUDESCOPE_VERSION__: string | undefined;
export const APP_VERSION =
  typeof __CLAUDESCOPE_VERSION__ !== 'undefined' ? __CLAUDESCOPE_VERSION__ : '0.0.0-dev';

/**
 * Schema version of the shipped pricing default. Bump when the shipped
 * `pricing.json` shape — or its families/default rates — change, so an existing
 * user copy reconciles with the new default on the next boot instead of silently
 * shadowing it. A monotonic integer (not a content hash): the user copy is meant
 * to be edited, so only a real shipped change should trigger a reconcile.
 */
export const PRICING_SCHEMA_VERSION = 2;

/**
 * Reconcile the user-editable pricing file with the shipped default.
 *
 * Non-destructive and self-healing: on first run it seeds the user copy; when the
 * shipped schema version is newer than the user's, it backs up the old file to
 * `<path>.bak`, then merges so NEW shipped keys (models/families) appear while
 * every value the user customized wins. A corrupt user file is left untouched
 * (never discard user data). Paths are injectable for tests.
 */
export function reconcilePricingConfig(
  userPath: string = PRICING_PATH,
  defaultPath: string = DEFAULT_PRICING_PATH,
): void {
  // First run: no user copy yet → seed from the default (which carries the version).
  if (!existsSync(userPath)) {
    if (existsSync(defaultPath)) copyFileSync(defaultPath, userPath);
    return;
  }
  if (!existsSync(defaultPath)) return; // nothing to reconcile against (dev without a build)

  let user: PricingConfig;
  let shipped: PricingConfig;
  try {
    user = JSON.parse(readFileSync(userPath, 'utf8')) as PricingConfig;
    shipped = JSON.parse(readFileSync(defaultPath, 'utf8')) as PricingConfig;
  } catch {
    // Corrupt user (or default) file: leave the user's file alone — never discard
    // their edits. loadPricing surfaces a clear error if the base is unreadable.
    console.warn(`[pricing] could not read ${userPath} for reconciliation; leaving it untouched`);
    return;
  }

  const userV = typeof user.schemaVersion === 'number' ? user.schemaVersion : 0;
  const shippedV =
    typeof shipped.schemaVersion === 'number' ? shipped.schemaVersion : PRICING_SCHEMA_VERSION;
  // Up to date (or a user copy claiming to be newer): do nothing. Crucially, do
  // NOT rewrite — that would bump the mtime and needlessly bust loadPricing's cache.
  if (userV >= shippedV) return;

  // Back up the current file (single rollback copy), then merge: new shipped keys
  // are added, but every value the user set wins (user edits are preserved).
  copyFileSync(userPath, `${userPath}.bak`);
  const merged: PricingConfig = {
    schemaVersion: shippedV,
    models: { ...shipped.models, ...user.models },
    families: { ...(shipped.families ?? {}), ...(user.families ?? {}) },
    default: user.default ?? shipped.default,
  };
  // Atomic write: stage to a temp file then rename, so a reader never sees a torn
  // file (same idiom as the pricing-refresh snapshot writer).
  const tmp = `${userPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  renameSync(tmp, userPath);
  console.warn(
    `[pricing] migrated ${userPath} schema v${userV} → v${shippedV}; ` +
      `your edits were preserved and the previous file backed up to ${userPath}.bak`,
  );
}

/**
 * Create the state directory and reconcile the user-editable pricing file with
 * the shipped default (seed on first run; non-destructively migrate a stale
 * copy). Idempotent; call once at boot.
 */
export function ensureStateDir(): void {
  mkdirSync(CLAUDESCOPE_HOME, { recursive: true });
  reconcilePricingConfig();
}
