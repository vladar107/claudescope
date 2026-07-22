/**
 * rebuildIndex() integration test — the danger-zone discard-and-rebuild path
 * (data/index.ts) and its POST /api/index/rebuild endpoint.
 *
 * Covers the bug-prone edges: the rebuilt index must contain the SAME sessions
 * (the DuckDB file is a derived cache), ready must flip false→true around the
 * rebuild with dataVersion advanced, pricing must apply PROSPECTIVELY (a rate
 * change re-prices history only on rebuild, never on an incremental pass), a
 * reindex() during the rebuild must coalesce onto it (not race the closed
 * connection), and the endpoint must 409 while a rebuild is in flight.
 *
 * Determinism: rebuildIndex() sets `rebuilding` and clears `ready`
 * synchronously when nothing is in flight, so mid-flight states are asserted
 * without sleeps; pricing rewrites bump mtime explicitly (loadPricing is
 * mtime-cached).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-rebuild-'));
const projectsDir = join(work, 'projects');
const pricingPath = join(work, 'pricing.json');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.PRICING_PATH = pricingPath;
process.env.FETCHED_PRICING_PATH = join(work, 'pricing.fetched.json'); // absent → base only
process.env.REINDEX_INTERVAL_MS = '0';
process.env.PRICING_REFRESH_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Exact-id rates so the expected cost is a closed-form number. */
const RATES_V1 = {
  schemaVersion: 4,
  models: { 'claude-opus-4-8': { input: 10, output: 20, cacheWrite: 0, cacheRead: 0 } },
  default: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
};
/** 10x the v1 rates — a rebuild must re-price history to these. */
const RATES_V2 = {
  schemaVersion: 4,
  models: { 'claude-opus-4-8': { input: 100, output: 200, cacheWrite: 0, cacheRead: 0 } },
  default: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
};
// sessX: 1000 in + 500 out → v1 (1000*10 + 500*20)/1e6 = 0.02; v2 = 0.2.
const COST_V1 = 0.02;
const COST_V2 = 0.2;

/**
 * Force a strictly-increasing mtime so loadPricing's mtime-keyed cache busts
 * even when two rewrites land in the same millisecond (pricing.test.ts idiom).
 */
let mtimeTick = Math.floor(Date.now() / 1000);
const bumpMtime = (path: string): void => {
  mtimeTick += 2;
  utimesSync(path, mtimeTick, mtimeTick);
};
const writePricing = (config: unknown): void => {
  writeFileSync(pricingPath, `${JSON.stringify(config, null, 2)}\n`);
  bumpMtime(pricingPath);
};

/** Two small Claude sessions in one project (session-set snapshot fodder). */
function writeFixtures(): void {
  const proj = join(projectsDir, 'enc-rebuild');
  mkdirSync(proj, { recursive: true });
  const base = { cwd: '/tmp/rebuildproj', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(proj, 'sessX.jsonl'),
    jsonl([
      { ...base, sessionId: 'sessX', type: 'user', uuid: 'x-u1', parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'rebuild me' } },
      { ...base, sessionId: 'sessX', type: 'assistant', uuid: 'x-a1', parentUuid: 'x-u1', timestamp: '2026-01-01T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'rebuilt' }], usage: { input_tokens: 1000, output_tokens: 500 } } },
    ]),
  );
  writeFileSync(
    join(proj, 'sessY.jsonl'),
    jsonl([
      { ...base, sessionId: 'sessY', type: 'user', uuid: 'y-u1', parentUuid: null, timestamp: '2026-01-02T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'second session' } },
      { ...base, sessionId: 'sessY', type: 'assistant', uuid: 'y-a1', parentUuid: 'y-u1', timestamp: '2026-01-02T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 50 } } },
    ]),
  );
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;
let data: typeof import('../src/data/index.js');

beforeAll(async () => {
  writeFixtures();
  writePricing(RATES_V1);

  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  data = await import('../src/data/index.js');
  ({ closeConnection } = await import('../src/db/duckdb.js'));

  app = Fastify();
  await registerRoutes(app);
  await data.reindex();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: 'GET', url });
const sessionIds = async (): Promise<string[]> =>
  ((await get('/api/sessions')).json() as { id: string }[]).map((s) => s.id).sort();
const costOf = async (id: string): Promise<number> => {
  const sessions = (await get('/api/sessions')).json() as { id: string; totalCostUsd: number }[];
  return sessions.find((s) => s.id === id)!.totalCostUsd;
};

describe('rebuildIndex()', () => {
  it('discards and rebuilds to the same sessions, flipping ready and advancing dataVersion', async () => {
    const before = (await get('/api/health')).json();
    expect(before.ready).toBe(true);
    const idsBefore = await sessionIds();
    expect(idsBefore).toEqual(['sessX', 'sessY']);

    const p = data.rebuildIndex();
    // With nothing in flight, the rebuild flags flip synchronously.
    expect(data.isRebuildInFlight()).toBe(true);
    expect(data.isIndexReady()).toBe(false);

    const res = await p;
    expect(res.reindexed).toBeGreaterThan(0); // an empty files table reloads everything
    expect(data.isRebuildInFlight()).toBe(false);

    const after = (await get('/api/health')).json();
    expect(after.ready).toBe(true);
    expect(after.dataVersion).not.toBe(before.dataVersion);
    expect(await sessionIds()).toEqual(idsBefore); // derived cache — same content
  });

  it('re-prices history at the current rates on rebuild, but NOT on an incremental pass', async () => {
    expect(await costOf('sessX')).toBeCloseTo(COST_V1, 6);

    writePricing(RATES_V2);

    // Incremental pass: no file changed, so no event rows are re-stamped —
    // pricing changes are prospective.
    const re = await app.inject({ method: 'POST', url: '/api/reindex' });
    expect(re.statusCode).toBe(200);
    expect(re.json().reindexed).toBe(0);
    expect(await costOf('sessX')).toBeCloseTo(COST_V1, 6);

    // Rebuild: every event reloads through the cost expression → new rates.
    await data.rebuildIndex();
    expect(await costOf('sessX')).toBeCloseTo(COST_V2, 6);
  });

  it('coalesces a reindex() called while the rebuild is in flight', async () => {
    const p = data.rebuildIndex(); // occupies the shared in-flight slot synchronously
    const r = data.reindex(); // must join the rebuild, not race the closed connection
    const [rebuildRes, reindexRes] = await Promise.all([p, r]);
    // Joining resolves to the SAME response object — proof of coalescing.
    expect(reindexRes).toBe(rebuildRes);
    expect(data.isIndexReady()).toBe(true);
  });
});

describe('POST /api/index/rebuild', () => {
  it('409s while a rebuild is in flight, 202s otherwise, and recovers to ready', async () => {
    const p = data.rebuildIndex(); // rebuilding=true synchronously
    const conflict = await app.inject({ method: 'POST', url: '/api/index/rebuild' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: expect.stringContaining('progress') });
    await p;

    const accepted = await app.inject({ method: 'POST', url: '/api/index/rebuild' });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ started: true });

    // The endpoint's rebuild runs in the background — drain it, then the index
    // must be fully queryable again.
    await vi.waitFor(
      () => {
        expect(data.isRebuildInFlight()).toBe(false);
        expect(data.isReindexInFlight()).toBe(false);
      },
      { timeout: 25_000, interval: 50 },
    );
    expect((await get('/api/health')).json().ready).toBe(true);
    expect(await sessionIds()).toEqual(['sessX', 'sessY']);
  });
});
