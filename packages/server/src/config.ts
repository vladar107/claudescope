/** Centralized server configuration constants. */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PricingConfig } from '@claudescope/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Return the first candidate path that exists, or `fallback` if none do. */
export function firstExisting(candidates: string[], fallback: string): string {
  return candidates.find((p) => existsSync(p)) ?? fallback;
}

/** Default TCP port when none is configured. */
export const DEFAULT_PORT = 4317;

/**
 * TCP port the Fastify server listens on. Override with PORT.
 *
 * Validated because an unusable value used to reach `app.listen` and kill the
 * daemon instantly with ERR_SOCKET_BAD_PORT, which the CLI could only report as
 * a health timeout. Warn-and-fall-back rather than throw: this module is
 * imported at load time by the CLI, the server, and the MCP entry, so throwing
 * would break commands that never bind a port.
 */
function resolvePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn(
      `[config] ignoring PORT='${raw}' — expected an integer between 1 and 65535; ` +
        `using ${DEFAULT_PORT}`,
    );
    return DEFAULT_PORT;
  }
  return n;
}

export const PORT = resolvePort(process.env.PORT);

/** Root directory of the server package (resolved from dist or src at runtime). */
export const PACKAGE_ROOT = join(__dirname, '..');

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// NOTE: the READ-ONLY agent source dirs (CLAUDE_PROJECTS_DIR & co), the derived
// *_HOME memory dirs, and REINDEX_INTERVAL_MS moved to settings.ts as runtime
// getters — they resolve env > settings.json > default PER CALL, so the web
// UI's Settings page can change them without a process restart. The consts
// remaining here are infra frozen at boot (port, state paths, intervals wired
// to boot-time timers).

/** Whether to auto-open the default browser on startup (set by the launcher). */
export const OPEN_BROWSER = process.env.OPEN_BROWSER === '1';

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
 * How often (ms) the daemon checks whether the installed `claudescope` on PATH
 * is a different version than the running process and, if so, restarts itself
 * into the new code (post-update self-heal — see self-restart.ts). Set
 * SELF_RESTART_INTERVAL_MS=0 to disable. Default 5 min.
 */
export const SELF_RESTART_INTERVAL_MS = Number(
  process.env.SELF_RESTART_INTERVAL_MS ?? 5 * 60 * 1000,
);

/**
 * Whether the daemon/CLI may automatically restart a version-skewed daemon.
 * Read per call — not frozen at import — so CLAUDESCOPE_AUTO_RESTART=0 applies
 * to a long-lived process and tests can flip it.
 */
export function autoRestartEnabled(): boolean {
  return process.env.CLAUDESCOPE_AUTO_RESTART !== '0';
}

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
export const PRICING_SCHEMA_VERSION = 4;

/**
 * Reconcile the user-editable pricing file with the shipped default.
 *
 * Non-destructive and self-healing: on first run it seeds the user copy; when the
 * shipped schema version is newer than the user's, it backs up the old file to
 * `<path>.bak`, then merges so NEW shipped keys (models/families/providers) appear
 * while every value the user customized wins. A corrupt user file is left untouched
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
    providers: { ...(shipped.providers ?? {}), ...(user.providers ?? {}) },
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
 * Mode for app-owned state files. The index is a searchable copy of every
 * transcript we can read, so it must not be more permissive than the sources it
 * derives from — `~/.claude/projects` is 0700, and a default-umask 0644
 * `index.duckdb` would hand the whole corpus (plus its FTS index) to any local
 * user. Same reasoning for the normalize cache, which holds transcript text
 * verbatim.
 */
export const STATE_FILE_MODE = 0o600;

/** Mode for app-owned state directories (see {@link STATE_FILE_MODE}). */
export const STATE_DIR_MODE = 0o700;

/**
 * Create an app-owned state directory owner-only, tightening an existing dir
 * that a previous version created with the default umask. Every writer of
 * {@link CLAUDESCOPE_HOME} (and its subdirs) goes through this so the mode can't
 * drift back at one of the call sites.
 */
export function ensureStateDir(dir: string = CLAUDESCOPE_HOME): void {
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  try {
    // Pre-existing dirs keep their old mode through mkdirSync — tighten in place.
    if ((statSync(dir).mode & 0o777) !== STATE_DIR_MODE) chmodSync(dir, STATE_DIR_MODE);
  } catch {
    /* best-effort: a mode we can't read or set must not block startup */
  }
}

/**
 * Boot-time setup: create the state directory owner-only and reconcile the
 * user-editable pricing file with the shipped default (seed on first run;
 * non-destructively migrate a stale copy). Idempotent; call once at boot.
 */
export function initStateDir(): void {
  ensureStateDir();
  reconcilePricingConfig();
}
