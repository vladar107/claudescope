/**
 * Tests for the layered pricing loader and the cost join.
 *
 * Two parts:
 *  - loadPricing precedence + mtime-keyed cache invalidation, driven by temp
 *    PRICING_PATH / FETCHED_PRICING_PATH files (env set before the module under
 *    test imports, since config.ts reads env at import time).
 *  - an end-to-end cost check: a synthetic Claude transcript is indexed into a
 *    throwaway DuckDB, and per-event `cost_usd` is verified against an exact-id
 *    join rate, a family fallback, and the default fallback.
 *
 * No network, no real ~/.claude* dirs.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PricingConfig } from '@claudescope/shared';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-pricing-merge-'));
const pricingPath = join(work, 'pricing.json');
const fetchedPath = join(work, 'pricing.fetched.json');
const projectsDir = join(work, 'projects');
const dbPath = join(work, 'index.duckdb');

process.env.PRICING_PATH = pricingPath;
process.env.FETCHED_PRICING_PATH = fetchedPath;
process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty');
process.env.DUCKDB_PATH = dbPath;
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';
process.env.PRICING_REFRESH_INTERVAL_MS = '0';

/** A base pricing config with one exact model, families, and a default. */
const BASE: PricingConfig = {
  models: {
    'claude-opus-4-8': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
    'only-in-base': { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 },
  },
  families: {
    sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  },
  default: { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 },
};

const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/**
 * Force a file's mtime forward to a strictly-increasing value so the loader's
 * mtime-keyed cache busts even when two rewrites land in the same millisecond.
 */
let mtimeTick = Math.floor(Date.now() / 1000);
const bumpMtime = (path: string): void => {
  mtimeTick += 2;
  utimesSync(path, mtimeTick, mtimeTick);
};

const { loadPricing } = await import('../src/data/pricing.js');
const { reconcilePricingConfig, PRICING_SCHEMA_VERSION } = await import('../src/config.js');

describe('loadPricing — layered merge', () => {
  beforeAll(() => {
    writeJson(pricingPath, BASE);
    if (existsSync(fetchedPath)) rmSync(fetchedPath);
  });

  it('returns the base config when no fetched snapshot exists', () => {
    const cfg = loadPricing();
    expect(cfg.models['claude-opus-4-8']).toEqual(BASE.models['claude-opus-4-8']);
    expect(cfg.families).toEqual(BASE.families);
    expect(cfg.default).toEqual(BASE.default);
  });

  it('lets fetched rates win per exact id, keeps base-only models, base families/default', () => {
    writeJson(fetchedPath, {
      fetchedAt: new Date().toISOString(),
      models: {
        // overrides the base exact id
        'claude-opus-4-8': { input: 20, output: 100, cacheWrite: 25, cacheRead: 2 },
        // a model only the fetched layer knows about
        'gpt-5-codex': { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0 },
      },
    });

    const cfg = loadPricing();
    // fetched wins on the shared id
    expect(cfg.models['claude-opus-4-8']).toEqual({ input: 20, output: 100, cacheWrite: 25, cacheRead: 2 });
    // base-only model survives the merge
    expect(cfg.models['only-in-base']).toEqual(BASE.models['only-in-base']);
    // fetched-only model is present
    expect(cfg.models['gpt-5-codex']).toEqual({ input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0 });
    // families/default always come from the base layer
    expect(cfg.families).toEqual(BASE.families);
    expect(cfg.default).toEqual(BASE.default);
  });

  it('ignores a corrupt fetched file (base-only, no throw)', () => {
    writeFileSync(fetchedPath, '{ this is not json');
    bumpMtime(fetchedPath);
    const cfg = loadPricing();
    expect(cfg.models['claude-opus-4-8']).toEqual(BASE.models['claude-opus-4-8']);
    expect(cfg.models['gpt-5-codex']).toBeUndefined();
  });

  it('re-reads when the fetched file mtime changes (cache invalidation)', () => {
    writeJson(fetchedPath, {
      fetchedAt: new Date().toISOString(),
      models: { 'claude-opus-4-8': { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } },
    });
    bumpMtime(fetchedPath);
    const cfg = loadPricing();
    expect(cfg.models['claude-opus-4-8']).toEqual({ input: 1, output: 1, cacheWrite: 1, cacheRead: 1 });

    // Rewrite with new rates and bump mtime again → reload must reflect them.
    writeJson(fetchedPath, {
      fetchedAt: new Date().toISOString(),
      models: { 'claude-opus-4-8': { input: 7, output: 8, cacheWrite: 9, cacheRead: 10 } },
    });
    bumpMtime(fetchedPath);
    const reloaded = loadPricing();
    expect(reloaded.models['claude-opus-4-8']).toEqual({ input: 7, output: 8, cacheWrite: 9, cacheRead: 10 });
  });
});

describe('reconcilePricingConfig — versioned migration', () => {
  let dir: string;
  let userPath: string;
  let defaultPath: string;

  const SHIPPED = {
    schemaVersion: PRICING_SCHEMA_VERSION,
    models: {
      'shared-model': { input: 2, output: 2, cacheWrite: 2, cacheRead: 2 },
      'shipped-only': { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 },
    },
    families: {
      opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
      newfam: { input: 7, output: 7, cacheWrite: 7, cacheRead: 7 },
    },
    // The v3 shipped default carries a `providers` layer (local runtimes zero-rated).
    providers: {
      lmstudio: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      ollama: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    },
    default: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claudescope-pricing-migrate-'));
    userPath = join(dir, 'pricing.json');
    defaultPath = join(dir, 'pricing.default.json');
    writeJson(defaultPath, SHIPPED);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('seeds the user copy on first run', () => {
    reconcilePricingConfig(userPath, defaultPath);
    expect(existsSync(userPath)).toBe(true);
    expect(JSON.parse(readFileSync(userPath, 'utf8')).schemaVersion).toBe(PRICING_SCHEMA_VERSION);
  });

  it('migrates a legacy copy: preserves user edits, adds new shipped keys, backs up', () => {
    const legacyUser = {
      // no schemaVersion → treated as v0
      models: {
        'shared-model': { input: 99, output: 99, cacheWrite: 99, cacheRead: 99 },
        'user-only': { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 },
      },
      families: { opus: { input: 100, output: 100, cacheWrite: 100, cacheRead: 100 } },
      default: { input: 42, output: 42, cacheWrite: 42, cacheRead: 42 },
    };
    writeJson(userPath, legacyUser);

    reconcilePricingConfig(userPath, defaultPath);

    // The previous file is backed up verbatim.
    expect(JSON.parse(readFileSync(`${userPath}.bak`, 'utf8'))).toEqual(legacyUser);

    const merged = JSON.parse(readFileSync(userPath, 'utf8'));
    expect(merged.schemaVersion).toBe(PRICING_SCHEMA_VERSION);
    // User edits win on shared keys…
    expect(merged.models['shared-model']).toEqual(legacyUser.models['shared-model']);
    expect(merged.families.opus).toEqual(legacyUser.families.opus);
    expect(merged.default).toEqual(legacyUser.default);
    // …user-only keys survive…
    expect(merged.models['user-only']).toEqual(legacyUser.models['user-only']);
    // …and new shipped keys are added.
    expect(merged.models['shipped-only']).toEqual(SHIPPED.models['shipped-only']);
    expect(merged.families.newfam).toEqual(SHIPPED.families.newfam);
  });

  it('adds the shipped providers set when migrating a v2 copy that predates providers', () => {
    // A v2 user copy from before the `providers` layer existed → the migration
    // must fold in the shipped providers (the local-runtime zero-rate table).
    const v2User = {
      schemaVersion: 2,
      models: { 'shared-model': { input: 99, output: 99, cacheWrite: 99, cacheRead: 99 } },
      families: { opus: { input: 100, output: 100, cacheWrite: 100, cacheRead: 100 } },
      default: { input: 42, output: 42, cacheWrite: 42, cacheRead: 42 },
    };
    writeJson(userPath, v2User);

    reconcilePricingConfig(userPath, defaultPath);

    const merged = JSON.parse(readFileSync(userPath, 'utf8'));
    expect(merged.schemaVersion).toBe(PRICING_SCHEMA_VERSION);
    // User edits still win where they overlap…
    expect(merged.models['shared-model']).toEqual(v2User.models['shared-model']);
    // …and the shipped providers layer is now present and zero-rated.
    expect(merged.providers.lmstudio).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  });

  it('keeps a user-defined provider entry through the merge and still gains shipped ids', () => {
    const withProxy = {
      schemaVersion: 2,
      models: {},
      // A custom provider the user added — must survive the merge verbatim.
      providers: { 'my-proxy': { input: 4, output: 8, cacheWrite: 0, cacheRead: 1 } },
      default: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    };
    writeJson(userPath, withProxy);

    reconcilePricingConfig(userPath, defaultPath);

    const merged = JSON.parse(readFileSync(userPath, 'utf8'));
    // The user's custom provider survives untouched…
    expect(merged.providers['my-proxy']).toEqual({ input: 4, output: 8, cacheWrite: 0, cacheRead: 1 });
    // …alongside the shipped ids the migration adds.
    expect(merged.providers.lmstudio).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  });

  it('is a no-op when the user copy is already current (no rewrite, no backup)', () => {
    writeJson(userPath, SHIPPED);
    const before = statSync(userPath).mtimeMs;
    reconcilePricingConfig(userPath, defaultPath);
    expect(statSync(userPath).mtimeMs).toBe(before);
    expect(existsSync(`${userPath}.bak`)).toBe(false);
  });

  it('leaves a corrupt user file untouched (no throw, no data loss)', () => {
    writeFileSync(userPath, '{ not valid json');
    expect(() => reconcilePricingConfig(userPath, defaultPath)).not.toThrow();
    expect(readFileSync(userPath, 'utf8')).toBe('{ not valid json');
    expect(existsSync(`${userPath}.bak`)).toBe(false);
  });
});

describe('cost via the pricing join table', () => {
  let app: FastifyInstance;
  let closeConnection: () => Promise<void>;
  let queryRows: (conn: unknown, sql: string) => Promise<Record<string, unknown>[]>;
  let getConnection: () => Promise<unknown>;

  const jsonl = (events: unknown[]): string =>
    events.map((e) => JSON.stringify(e)).join('\n') + '\n';

  beforeAll(async () => {
    // Base pricing for the cost test: an exact id, a family substring, a default,
    // plus a `providers` layer zero-rating a local runtime. A provider match must
    // OVERRIDE the whole model chain (exact id / family / default).
    writeJson(pricingPath, {
      ...BASE,
      providers: { lmstudio: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } },
    });
    bumpMtime(pricingPath);
    // Fetched layer overrides the exact-id rate to prove the join uses it.
    writeJson(fetchedPath, {
      fetchedAt: new Date().toISOString(),
      models: { 'claude-opus-4-8': { input: 30, output: 150, cacheWrite: 0, cacheRead: 0 } },
    });
    bumpMtime(fetchedPath);

    // A pi session exercising provider precedence in the cost CASE: one turn on a
    // local provider (`lmstudio`) and one on an unknown provider (`custom-gateway`),
    // both on `claude-opus-4-8` — a model with a real exact-id rate (fetched 30).
    const piDir = process.env.PI_SESSIONS_DIR as string;
    const piSess = join(piDir, '--tmp-piproj--');
    mkdirSync(piSess, { recursive: true });
    writeFileSync(
      join(piSess, '2026-01-01T10-00-00-000Z_pricing-pi.jsonl'),
      jsonl([
        { type: 'session', version: 3, id: 'pricing-pi-1', timestamp: '2026-01-01T10:00:00.000Z', cwd: '/tmp/piproj' },
        { type: 'message', id: 'pu1', parentId: null, timestamp: '2026-01-01T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'local vs gateway' }] } },
        { type: 'message', id: 'pa1', parentId: 'pu1', timestamp: '2026-01-01T10:00:02.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', provider: 'lmstudio', content: [{ type: 'text', text: 'served locally' }], usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } } },
        { type: 'message', id: 'pa2', parentId: 'pa1', timestamp: '2026-01-01T10:00:03.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', provider: 'custom-gateway', content: [{ type: 'text', text: 'served via gateway' }], usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } } },
      ]),
    );

    const proj = join(projectsDir, 'enc-projX');
    mkdirSync(proj, { recursive: true });
    const base = { sessionId: 'sessX', cwd: '/tmp/projX', isSidechain: false };
    writeFileSync(
      join(proj, 'sessX.jsonl'),
      jsonl([
        // exact-id match → fetched rate (input 30): 100 * 30 / 1e6 = 0.003
        { ...base, type: 'assistant', uuid: 'x1', parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 100, output_tokens: 0 } } },
        // family match (sonnet, input 3): 100 * 3 / 1e6 = 0.0003
        { ...base, type: 'assistant', uuid: 'x2', parentUuid: 'x1', timestamp: '2026-01-01T10:00:05.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-5-20251001', content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 100, output_tokens: 0 } } },
        // default fallback (input 1): 100 * 1 / 1e6 = 0.0001
        { ...base, type: 'assistant', uuid: 'x3', parentUuid: 'x2', timestamp: '2026-01-01T10:00:10.000Z', message: { role: 'assistant', model: 'some-unknown-model', content: [{ type: 'text', text: 'c' }], usage: { input_tokens: 100, output_tokens: 0 } } },
      ]),
    );

    const Fastify = (await import('fastify')).default;
    const { reindex } = await import('../src/data/index.js');
    ({ getConnection, queryRows } = await import('../src/db/duckdb.js'));
    ({ closeConnection } = await import('../src/db/duckdb.js'));

    app = Fastify();
    await reindex();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closeConnection?.();
  });

  const costOf = async (uuid: string): Promise<number> => {
    const conn = await getConnection();
    const rows = await queryRows(conn, `SELECT cost_usd FROM events WHERE uuid = '${uuid}'`);
    return Number(rows[0]?.cost_usd);
  };

  it('uses the exact-id (fetched) rate from the join table', async () => {
    expect(await costOf('x1')).toBeCloseTo((100 * 30) / 1e6, 12);
  });

  it('falls back to a family rate when no exact id joins', async () => {
    expect(await costOf('x2')).toBeCloseTo((100 * 3) / 1e6, 12);
  });

  it('falls back to the default rate when neither id nor family matches', async () => {
    expect(await costOf('x3')).toBeCloseTo((100 * 1) / 1e6, 12);
  });

  const costWhere = async (where: string): Promise<number> => {
    const conn = await getConnection();
    const rows = await queryRows(conn, `SELECT cost_usd FROM events WHERE ${where}`);
    expect(rows).toHaveLength(1);
    return Number(rows[0]?.cost_usd);
  };

  it('lets a local provider override the exact-id model rate (cost 0)', async () => {
    // `lmstudio` is zero-rated in `providers`; the turn is on `claude-opus-4-8`,
    // which has a real exact-id rate (fetched 30) — the provider match must win.
    expect(await costWhere("session_id = 'pricing-pi-1' AND provider = 'lmstudio'")).toBe(0);
  });

  it('falls through to the model chain for an unknown provider', async () => {
    // `custom-gateway` isn't listed → the CASE falls through to the model chain,
    // pricing by the exact-id rate exactly like the NULL-provider Claude turn x1
    // (same model + 100 input tokens).
    const gateway = await costWhere("session_id = 'pricing-pi-1' AND provider = 'custom-gateway'");
    expect(gateway).toBeCloseTo((100 * 30) / 1e6, 12);
    expect(gateway).toBeCloseTo(await costOf('x1'), 12);
  });
});

// Best-effort cleanup of the temp dir after the suite.
process.on('exit', () => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
