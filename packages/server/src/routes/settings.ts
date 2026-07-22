/**
 * Settings API: read the effective configuration (with per-key provenance)
 * and persist edits to `~/.claudescope/settings.json`. Live-applicable
 * changes take effect immediately — a source-dir change kicks a reindex pass,
 * an interval change re-arms the poller.
 */

import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type {
  EditableSetting,
  ReadOnlySetting,
  SettingValue,
  SettingsResponse,
  SettingsUpdateRequest,
  SettingsUpdateResponse,
} from '@claudescope/shared';
import {
  CLAUDESCOPE_HOME,
  DUCKDB_PATH,
  FETCHED_PRICING_PATH,
  PORT,
  PRICING_PATH,
} from '../config.js';
import {
  SETTING_DEFS,
  SETTINGS_SCHEMA_VERSION,
  fileValueOf,
  resolveSetting,
  saveSettings,
  validateSettingsPatch,
  type SettingKey,
} from '../settings.js';
import { rearmTimer, requestPass } from '../indexer-lifecycle.js';
import { contractHome } from '../util/paths.js';

/** Contract the home dir in path values for display; pass others through. */
function displayValue(kind: 'path' | 'number' | 'boolean', v: SettingValue): SettingValue {
  return kind === 'path' && typeof v === 'string' ? contractHome(v) : v;
}

function buildSettingsResponse(): SettingsResponse {
  const editable: EditableSetting[] = SETTING_DEFS.map((def) => {
    const { value, source } = resolveSetting(def.key);
    const fileValue = fileValueOf(def.key);
    const row: EditableSetting = {
      key: def.key,
      label: def.label,
      group: def.group,
      type: def.kind,
      effective: displayValue(def.kind, value),
      source,
      defaultValue: displayValue(def.kind, def.defaultValue()),
      live: def.live,
    };
    if (def.envVar) row.envVar = def.envVar;
    if (fileValue !== undefined) row.fileValue = displayValue(def.kind, fileValue);
    if (def.connectorId) row.connectorId = def.connectorId;
    if (def.kind === 'path') row.exists = existsSync(value as string);
    return row;
  });

  // Infra frozen at boot — shown for transparency, changed via env/CLI only.
  const readOnlyDefs: { key: string; label: string; envVar?: string; value: string | number }[] = [
    { key: 'port', label: 'Port', envVar: 'PORT', value: PORT },
    {
      key: 'claudescopeHome',
      label: 'State directory',
      envVar: 'CLAUDESCOPE_HOME',
      value: contractHome(CLAUDESCOPE_HOME),
    },
    {
      key: 'duckdbPath',
      label: 'DuckDB index',
      envVar: 'DUCKDB_PATH',
      value: contractHome(DUCKDB_PATH),
    },
    {
      key: 'pricingPath',
      label: 'Pricing config',
      envVar: 'PRICING_PATH',
      value: contractHome(PRICING_PATH),
    },
    {
      key: 'fetchedPricingPath',
      label: 'Fetched pricing snapshot',
      envVar: 'FETCHED_PRICING_PATH',
      value: contractHome(FETCHED_PRICING_PATH),
    },
  ];
  const readOnly: ReadOnlySetting[] = readOnlyDefs.map((d) => ({
    ...d,
    source: d.envVar && process.env[d.envVar] != null ? 'env' : 'default',
  }));

  return { schemaVersion: SETTINGS_SCHEMA_VERSION, editable, readOnly };
}

export async function registerSettingsRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async (): Promise<SettingsResponse> => buildSettingsResponse());

  app.put('/api/settings', async (req, reply): Promise<SettingsUpdateResponse | undefined> => {
    const set = (req.body as SettingsUpdateRequest | undefined)?.set;
    if (!set || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length === 0) {
      void reply.code(400).send({ error: 'body must be { set: { <key>: value | null } }' });
      return;
    }

    // Normalize path strings before validating/saving.
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(set)) {
      patch[key] = typeof value === 'string' ? value.trim() : value;
    }

    const { errors, warnings } = validateSettingsPatch(patch);
    if (Object.keys(errors).length > 0) {
      void reply.code(400).send({ error: 'invalid settings', fields: errors });
      return;
    }

    // Snapshot the pre-save effective values so we only live-apply on REAL
    // change (a save that is shadowed by an env var must not kick a reindex).
    const before = new Map(SETTING_DEFS.map((d) => [d.key, resolveSetting(d.key).value]));
    saveSettings(patch as Partial<Record<SettingKey, SettingValue | null>>);

    const applied: SettingsUpdateResponse['applied'] = [];
    let sourcesChanged = false;
    let intervalChanged = false;
    for (const key of Object.keys(patch)) {
      const def = SETTING_DEFS.find((d) => d.key === key);
      if (!def) continue;
      applied.push({ key, live: def.live });
      if (before.get(def.key) !== resolveSetting(def.key).value) {
        if (def.group === 'sources') sourcesChanged = true;
        if (def.key === 'reindexIntervalMs') intervalChanged = true;
      }
    }

    if (intervalChanged) rearmTimer();
    if (sourcesChanged) {
      // Fire and forget: the pass surfaces through /api/health + dataVersion.
      requestPass().catch((err) => app.log.warn({ err }, 'post-settings reindex failed'));
    }

    return { settings: buildSettingsResponse(), applied, warnings };
  });
}
