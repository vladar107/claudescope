/**
 * User-editable runtime settings, persisted to `~/.claudescope/settings.json`.
 *
 * Precedence per key, computed at every call: **env var > settings.json >
 * default**. Env vars keep winning so scripted overrides and the existing test
 * harness (env set before import) behave exactly as before; the file is the
 * layer the web UI writes. The file read is mtime-cached (same idiom as
 * `loadPricing`), so hand edits are picked up on the next call without a
 * restart, and getters stay cheap enough to call once per discovery pass or
 * API request.
 *
 * Layering: `config.ts` (frozen infra consts) ← this module ← connectors /
 * indexer / routes / CLI. Nothing here writes outside CLAUDESCOPE_HOME.
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { SettingSource, SettingValue } from '@claudescope/shared';
import { CLAUDESCOPE_HOME, expandHome, firstExisting } from './config.js';

export const SETTINGS_SCHEMA_VERSION = 1;

/** The user-editable settings file (lives with the rest of the app state). */
export const SETTINGS_PATH = join(CLAUDESCOPE_HOME, 'settings.json');

export type SettingKey =
  | 'claudeProjectsDir'
  | 'codexSessionsDir'
  | 'junieSessionsDir'
  | 'piSessionsDir'
  | 'opencodeDataDir'
  | 'opencodeDbPath'
  | 'copilotSessionsDir'
  | 'grokSessionsDir'
  | 'antigravityCliDir'
  | 'antigravityDir'
  | 'reindexIntervalMs'
  | 'openBrowser';

export interface SettingDef {
  key: SettingKey;
  /** Env var that overrides this setting; null = no env layer (openBrowser —
   *  its OPEN_BROWSER var is the internal launcher contract, always pinned by
   *  the daemon spawner, so reading it here would misreport user intent). */
  envVar: string | null;
  kind: 'path' | 'number' | 'boolean';
  label: string;
  group: 'sources' | 'indexing' | 'startup';
  /** Connector fed by this dir (sources only), for UI labeling. */
  connectorId?: string;
  /** False → the change takes effect on the next `claudescope start`. */
  live: boolean;
  /** Lazy so derived defaults (opencodeDbPath) track their base setting live. */
  defaultValue: () => SettingValue;
}

/**
 * Single source of truth driving resolution, validation, and the settings API.
 * Defaults are copied VERBATIM from the former config.ts consts — including
 * opencode's XDG_DATA_HOME fallback chain — so the const→getter migration
 * cannot silently change a default.
 */
export const SETTING_DEFS: readonly SettingDef[] = [
  {
    key: 'claudeProjectsDir',
    envVar: 'CLAUDE_PROJECTS_DIR',
    kind: 'path',
    label: 'Claude Code projects',
    group: 'sources',
    connectorId: 'claude-code',
    live: true,
    defaultValue: () => join(homedir(), '.claude', 'projects'),
  },
  {
    key: 'codexSessionsDir',
    envVar: 'CODEX_SESSIONS_DIR',
    kind: 'path',
    label: 'Codex sessions',
    group: 'sources',
    connectorId: 'codex',
    live: true,
    defaultValue: () => join(homedir(), '.codex', 'sessions'),
  },
  {
    key: 'junieSessionsDir',
    envVar: 'JUNIE_SESSIONS_DIR',
    kind: 'path',
    label: 'Junie sessions',
    group: 'sources',
    connectorId: 'junie',
    live: true,
    defaultValue: () => join(homedir(), '.junie', 'sessions'),
  },
  {
    key: 'piSessionsDir',
    envVar: 'PI_SESSIONS_DIR',
    kind: 'path',
    label: 'pi sessions',
    group: 'sources',
    connectorId: 'pi',
    live: true,
    defaultValue: () => join(homedir(), '.pi', 'agent', 'sessions'),
  },
  {
    key: 'opencodeDataDir',
    envVar: 'OPENCODE_DATA_DIR',
    kind: 'path',
    label: 'opencode data dir',
    group: 'sources',
    connectorId: 'opencode',
    live: true,
    defaultValue: () =>
      expandHome(
        join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode'),
      ),
  },
  {
    key: 'opencodeDbPath',
    envVar: 'OPENCODE_DB_PATH',
    kind: 'path',
    label: 'opencode database',
    group: 'sources',
    connectorId: 'opencode',
    live: true,
    // Derives from the EFFECTIVE data dir, so editing opencodeDataDir moves
    // the default DB path along with it.
    defaultValue: () => join(opencodeDataDir(), 'opencode.db'),
  },
  {
    key: 'copilotSessionsDir',
    envVar: 'COPILOT_SESSIONS_DIR',
    kind: 'path',
    label: 'Copilot sessions',
    group: 'sources',
    connectorId: 'copilot',
    live: true,
    defaultValue: () => join(homedir(), '.copilot', 'session-state'),
  },
  {
    key: 'grokSessionsDir',
    envVar: 'GROK_SESSIONS_DIR',
    kind: 'path',
    label: 'Grok sessions',
    group: 'sources',
    connectorId: 'grok',
    live: true,
    defaultValue: () => join(homedir(), '.grok', 'sessions'),
  },
  {
    key: 'antigravityCliDir',
    envVar: 'ANTIGRAVITY_CLI_DIR',
    kind: 'path',
    label: 'Antigravity (CLI)',
    group: 'sources',
    connectorId: 'antigravity',
    live: true,
    defaultValue: () => join(homedir(), '.gemini', 'antigravity-cli'),
  },
  {
    key: 'antigravityDir',
    envVar: 'ANTIGRAVITY_DIR',
    kind: 'path',
    label: 'Antigravity (desktop)',
    group: 'sources',
    connectorId: 'antigravity',
    live: true,
    defaultValue: () => join(homedir(), '.gemini', 'antigravity'),
  },
  {
    key: 'reindexIntervalMs',
    envVar: 'REINDEX_INTERVAL_MS',
    kind: 'number',
    label: 'Auto-reindex interval (ms)',
    group: 'indexing',
    live: true,
    defaultValue: () => 15000,
  },
  {
    key: 'openBrowser',
    envVar: null,
    kind: 'boolean',
    label: 'Open browser on start',
    group: 'startup',
    live: false, // consumed by the CLI at the next `claudescope start`
    defaultValue: () => true,
  },
] as const;

const DEFS_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

// ---------------------------------------------------------------------------
// File layer (mtime-cached read, atomic write)
// ---------------------------------------------------------------------------

/** Sentinel mtime for a file that does not exist. */
const ABSENT = -1;

let cached: { mtime: number; data: Record<string, unknown> } | null = null;
/** mtime we last warned about, so a corrupt file logs once, not per call. */
let warnedMtime: number | null = null;

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return ABSENT;
  }
}

/** Raw parsed settings.json (mtime-cached). Corrupt/missing → `{}`. */
function readSettingsFile(): Record<string, unknown> {
  const mtime = mtimeOf(SETTINGS_PATH);
  if (cached && cached.mtime === mtime) return cached.data;
  let data: Record<string, unknown> = {};
  if (mtime !== ABSENT) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      if (warnedMtime !== mtime) {
        warnedMtime = mtime;
        console.warn(`[settings] ${SETTINGS_PATH} is not valid JSON — using defaults`);
      }
    }
  }
  cached = { mtime, data };
  return data;
}

/** Whether a raw file value has the right JS type for the setting's kind. */
function typeOk(def: SettingDef, v: unknown): v is SettingValue {
  if (def.kind === 'path') return typeof v === 'string';
  if (def.kind === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === 'boolean';
}

/** The raw saved value for a key (unexpanded, for display), if present and valid. */
export function fileValueOf(key: SettingKey): SettingValue | undefined {
  const def = DEFS_BY_KEY.get(key);
  if (!def) return undefined;
  const v = readSettingsFile()[key];
  return typeOk(def, v) ? v : undefined;
}

export interface ResolvedSetting {
  value: SettingValue;
  source: SettingSource;
}

/** Resolve a setting through env > file > default, computed per call. */
export function resolveSetting(key: SettingKey): ResolvedSetting {
  const def = DEFS_BY_KEY.get(key);
  if (!def) throw new Error(`unknown setting: ${key}`);

  if (def.envVar) {
    const env = process.env[def.envVar];
    if (env != null) {
      if (def.kind === 'path') return { value: expandHome(env), source: 'env' };
      if (def.kind === 'number') {
        const n = Number(env);
        // An unparsable number env var is ignored (validate at the boundary,
        // fall through to the file/default) rather than poisoning the value.
        if (Number.isFinite(n)) return { value: n, source: 'env' };
      } else {
        return { value: env === '1', source: 'env' };
      }
    }
  }

  const fileValue = fileValueOf(key);
  if (fileValue !== undefined) {
    return {
      value: def.kind === 'path' ? expandHome(fileValue as string) : fileValue,
      source: 'file',
    };
  }

  return { value: def.defaultValue(), source: 'default' };
}

/**
 * Persist a patch to settings.json. `null` clears a key back to its default;
 * unknown keys already in the file are preserved (forward compatibility).
 * Fully synchronous, so concurrent callers in this single-threaded process
 * can never interleave a read-modify-write; last full call wins. Atomic on
 * disk via tmp + rename (idiom of `reconcilePricingConfig`).
 */
export function saveSettings(patch: Partial<Record<SettingKey, SettingValue | null>>): void {
  // Never silently destroy a hand-edited file we could not parse: keep a copy.
  const raw = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, 'utf8') : null;
  let current: Record<string, unknown> = {};
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.bak`);
      console.warn(`[settings] backed up corrupt ${SETTINGS_PATH} to settings.json.bak`);
    }
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete current[key];
    else if (value !== undefined) current[key] = value;
  }
  current.schemaVersion = SETTINGS_SCHEMA_VERSION;

  const tmp = `${SETTINGS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`);
  renameSync(tmp, SETTINGS_PATH);
  cached = null; // next read re-stats; rename bumps mtime but be explicit
}

// ---------------------------------------------------------------------------
// Validation (used by PUT /api/settings)
// ---------------------------------------------------------------------------

export interface SettingsValidation {
  /** Per-field hard errors; non-empty → reject the whole patch. */
  errors: Record<string, string>;
  /** Advisory only — the save proceeds (e.g. directory doesn't exist yet). */
  warnings: { key: string; message: string }[];
}

/** Validate a raw PUT patch. Type errors hard-fail; existence soft-warns. */
export function validateSettingsPatch(patch: Record<string, unknown>): SettingsValidation {
  const errors: Record<string, string> = {};
  const warnings: { key: string; message: string }[] = [];

  for (const [key, value] of Object.entries(patch)) {
    const def = DEFS_BY_KEY.get(key as SettingKey);
    if (!def) {
      errors[key] = 'unknown setting';
      continue;
    }
    if (value === null) continue; // clear back to default — always valid

    if (def.kind === 'path') {
      if (typeof value !== 'string' || value.trim() === '') {
        errors[key] = 'must be a non-empty path';
        continue;
      }
      const expanded = expandHome(value.trim());
      if (!isAbsolute(expanded)) {
        errors[key] = 'must be an absolute path (a leading ~ is expanded)';
        continue;
      }
      // A source dir may legitimately not exist yet (agent not installed) —
      // warn, don't fail. opencodeDbPath points at a file, not a directory.
      if (!existsSync(expanded)) {
        warnings.push({ key, message: 'path does not exist — this source will index nothing' });
      } else if (def.key !== 'opencodeDbPath' && !statSync(expanded).isDirectory()) {
        warnings.push({ key, message: 'path is not a directory' });
      }
    } else if (def.kind === 'number') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors[key] = 'must be an integer';
        continue;
      }
      if (value !== 0 && value < 1000) {
        errors[key] = 'must be 0 (disabled) or at least 1000 ms';
        continue;
      }
    } else if (typeof value !== 'boolean') {
      errors[key] = 'must be true or false';
      continue;
    }

    if (def.envVar && process.env[def.envVar] != null) {
      warnings.push({
        key,
        message: `saved, but $${def.envVar} currently overrides it`,
      });
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Effective-value getters (what connectors / the indexer / the CLI consume)
// ---------------------------------------------------------------------------

function pathOf(key: SettingKey): string {
  return resolveSetting(key).value as string;
}

/** READ-ONLY source of Claude Code session data. */
export function claudeProjectsDir(): string {
  return pathOf('claudeProjectsDir');
}
/** READ-ONLY source of OpenAI Codex CLI sessions. */
export function codexSessionsDir(): string {
  return pathOf('codexSessionsDir');
}
/** READ-ONLY source of JetBrains Junie sessions. */
export function junieSessionsDir(): string {
  return pathOf('junieSessionsDir');
}
/** READ-ONLY source of pi sessions. */
export function piSessionsDir(): string {
  return pathOf('piSessionsDir');
}
/** READ-ONLY opencode data dir (holds the SQLite DB). */
export function opencodeDataDir(): string {
  return pathOf('opencodeDataDir');
}
/** READ-ONLY opencode SQLite database file. */
export function opencodeDbPath(): string {
  return pathOf('opencodeDbPath');
}
/** READ-ONLY source of GitHub Copilot CLI sessions. */
export function copilotSessionsDir(): string {
  return pathOf('copilotSessionsDir');
}
/** READ-ONLY source of xAI Grok CLI sessions. */
export function grokSessionsDir(): string {
  return pathOf('grokSessionsDir');
}
/** READ-ONLY Antigravity CLI appDataDir. */
export function antigravityCliDir(): string {
  return pathOf('antigravityCliDir');
}
/** READ-ONLY Antigravity desktop appDataDir. */
export function antigravityDesktopDir(): string {
  return pathOf('antigravityDir');
}
/** Every Antigravity appDataDir the connector scans (both surfaces). */
export function antigravityDirs(): string[] {
  return [antigravityCliDir(), antigravityDesktopDir()];
}
/**
 * The Antigravity source dir reported to `/api/sources` — the first surface
 * that exists (CLI or desktop), resolved per call.
 */
export function antigravitySourceDir(): string {
  const cli = antigravityCliDir();
  return firstExisting([cli, antigravityDesktopDir()], cli);
}

/**
 * READ-ONLY agent home directories — parents of the session dirs above, where
 * each agent keeps its memory. Derived from the effective dirs so env AND
 * settings.json overrides carry through. The app MUST NEVER write here.
 */
export function claudeHome(): string {
  return dirname(claudeProjectsDir());
}
export function codexHome(): string {
  return dirname(codexSessionsDir());
}
export function junieHome(): string {
  return dirname(junieSessionsDir());
}
/** `~/.copilot` — holds the global `copilot-instructions.md` memory file. */
export function copilotHome(): string {
  return dirname(copilotSessionsDir());
}
/** `~/.gemini` — shared Gemini/Antigravity home, parent of the appDataDirs. */
export function antigravityHome(): string {
  return dirname(antigravityCliDir());
}

/** Auto-reindex interval in ms (0 = disabled). */
export function reindexIntervalMs(): number {
  return resolveSetting('reindexIntervalMs').value as number;
}

/** Whether `claudescope start` should open the browser (CLI-consumed). */
export function openBrowserOnStart(): boolean {
  return resolveSetting('openBrowser').value as boolean;
}

/** Test seam: drop the mtime cache so a rewritten file is re-read immediately. */
export function resetSettingsCache(): void {
  cached = null;
  warnedMtime = null;
}
