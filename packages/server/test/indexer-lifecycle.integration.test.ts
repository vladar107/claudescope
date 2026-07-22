/**
 * Indexer lifecycle integration test — the pause/resume/restart runtime state,
 * its surfacing on /api/health and the POST /api/indexer/* routes, and the
 * requestPass coalescing guarantee (a pass STARTS after the call; joining an
 * in-flight pass is not enough).
 *
 * Determinism notes: reindex() sets its in-flight slot synchronously, so
 * "pass in flight" can be produced without sleeps; and each completed pass
 * resolves to a DISTINCT response object, so "a second pass ran after the
 * joined one" is observable by object identity, not timing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-lifecycle-'));
const projectsDir = join(work, 'projects');

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
process.env.REINDEX_INTERVAL_MS = '0'; // poller disabled — lifecycle only

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** One tiny Claude session, written mid-test to observe the coalesced pass. */
function writeSessionFixture(): void {
  const proj = join(projectsDir, 'enc-lc');
  mkdirSync(proj, { recursive: true });
  const base = { sessionId: 'sess-lc1', cwd: '/tmp/lcproj', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(proj, 'sess-lc1.jsonl'),
    jsonl([
      { ...base, type: 'user', uuid: 'lc-u1', parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'hello lifecycle' } },
      { ...base, type: 'assistant', uuid: 'lc-a1', parentUuid: 'lc-u1', timestamp: '2026-01-01T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 5 } } },
    ]),
  );
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;
let reindex: () => Promise<{ reindexed: number; durationMs: number }>;
let isReindexInFlight: () => boolean;
let lifecycle: typeof import('../src/indexer-lifecycle.js');

beforeAll(async () => {
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  ({ reindex, isReindexInFlight } = await import('../src/data/index.js'));
  lifecycle = await import('../src/indexer-lifecycle.js');
  ({ closeConnection } = await import('../src/db/duckdb.js'));

  app = Fastify();
  await registerRoutes(app);
  await reindex(); // initial (empty) build → ready
  await app.ready();
});

afterAll(async () => {
  lifecycle?.resetIndexerLifecycle();
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

const get = (url: string) => app.inject({ method: 'GET', url });
const post = (url: string) => app.inject({ method: 'POST', url });

describe('POST /api/indexer/{stop,start,restart}', () => {
  it('stop pauses: IndexerStatus and health both report paused', async () => {
    const res = await post('/api/indexer/stop');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      state: 'paused',
      paused: true,
      intervalMs: 0,
      rebuilding: false,
    });

    const health = (await get('/api/health')).json();
    expect(health.indexer).toEqual({ state: 'paused', paused: true, intervalMs: 0 });
  });

  it('start resumes, runs an immediate fresh pass, and reports watching', async () => {
    // Object identity of lastPass distinguishes "a NEW pass completed" from
    // "the pre-pause pass is still the latest" without timing assumptions.
    const passBefore = lifecycle.getIndexerStatus().lastPass;

    const res = await post('/api/indexer/start');
    expect(res.statusCode).toBe(200);
    const status = res.json();
    expect(status).toMatchObject({ state: 'watching', paused: false, rebuilding: false });
    expect(typeof status.lastPassAt).toBe('string');
    expect(status.lastPass).toMatchObject({ reindexed: expect.any(Number) });

    expect(lifecycle.getIndexerStatus().lastPass).not.toBe(passBefore);
    expect((await get('/api/health')).json().indexer.state).toBe('watching');
  });

  it('restart clears pause and runs a fresh pass', async () => {
    await post('/api/indexer/stop');
    const passBefore = lifecycle.getIndexerStatus().lastPass;

    const res = await post('/api/indexer/restart');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'watching', paused: false });
    expect(lifecycle.getIndexerStatus().lastPass).not.toBe(passBefore);
  });
});

describe('requestPass coalescing guarantee', () => {
  it('drains an in-flight pass, then runs one MORE pass (never just joins)', async () => {
    // Start a pass; the in-flight slot is set synchronously, so this is a
    // deterministic "pass already running" state — no sleeps.
    const p1 = reindex();
    expect(isReindexInFlight()).toBe(true);

    // The "settings changed under a running pass" scenario: new data lands
    // between the pass start and the requestPass call.
    writeSessionFixture();
    const rp = lifecycle.requestPass();

    const [r1, r2] = await Promise.all([p1, rp]);
    // A joined pass resolves to the SAME response object; requestPass must
    // resolve to a different one — proof a second pass started after the call.
    expect(r2).not.toBe(r1);

    // And the post-change data is queryable once requestPass resolves.
    const sessions = (await get('/api/sessions')).json() as { id: string }[];
    expect(sessions.map((s) => s.id)).toContain('sess-lc1');
  });

  it('two concurrent requestPass calls both resolve (second drains the first)', async () => {
    const [a, b] = await Promise.all([lifecycle.requestPass(), lifecycle.requestPass()]);
    expect(a).toMatchObject({ reindexed: expect.any(Number) });
    expect(b).toMatchObject({ reindexed: expect.any(Number) });
    expect(b).not.toBe(a); // the second call ran its own pass
    expect(isReindexInFlight()).toBe(false);
  });
});

describe('rearmTimer with interval 0', () => {
  it('is a no-op (auto-reindex disabled): no timer, no throw, status intact', async () => {
    expect(() => lifecycle.rearmTimer()).not.toThrow();
    const status = lifecycle.getIndexerStatus();
    expect(status).toMatchObject({ state: 'watching', paused: false, intervalMs: 0 });
    expect((await get('/api/health')).json().indexer.intervalMs).toBe(0);
  });
});
