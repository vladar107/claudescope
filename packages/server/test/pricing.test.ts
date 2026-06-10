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

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
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

describe('cost via the pricing join table', () => {
  let app: FastifyInstance;
  let closeConnection: () => Promise<void>;
  let queryRows: (conn: unknown, sql: string) => Promise<Record<string, unknown>[]>;
  let getConnection: () => Promise<unknown>;

  const jsonl = (events: unknown[]): string =>
    events.map((e) => JSON.stringify(e)).join('\n') + '\n';

  beforeAll(async () => {
    // Base pricing for the cost test: an exact id, a family substring, a default.
    writeJson(pricingPath, BASE);
    // Fetched layer overrides the exact-id rate to prove the join uses it.
    writeJson(fetchedPath, {
      fetchedAt: new Date().toISOString(),
      models: { 'claude-opus-4-8': { input: 30, output: 150, cacheWrite: 0, cacheRead: 0 } },
    });
    bumpMtime(fetchedPath);

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
});

// Best-effort cleanup of the temp dir after the suite.
process.on('exit', () => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
