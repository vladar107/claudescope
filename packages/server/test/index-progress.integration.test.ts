/**
 * Indexing-progress integration tests — the /api/health `indexing` contract
 * (data/index.ts): a pass with work exposes a live {processed, total} counter,
 * skipped-unreadable files still advance it, the first build grows the derived
 * `sessions` table mid-pass (so /api/projects fills in while indexing), and a
 * no-change pass exposes no progress at all.
 *
 * The sampling pattern mirrors production: the HTTP routes query the same
 * DuckDB connection while a reindex pass runs on it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-progress-'));
const projectsDir = join(work, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';
// Force a partial `sessions` rebuild after every file so mid-pass growth is
// observable without depending on wall-clock timing.
process.env.PARTIAL_REBUILD_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

const READABLE_COUNT = 10;

/** chmod(000) only bites for a non-root POSIX user; skip the unreadable file
 *  elsewhere so the expected totals stay exact. */
const canMakeUnreadable =
  process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

/** Ten tiny sessions in one project, plus (where possible) one file DuckDB
 *  cannot open at all — the catch-path in the per-file loop. */
function writeFixtures(): void {
  const proj = join(projectsDir, 'enc-projP');
  mkdirSync(proj, { recursive: true });
  for (let i = 0; i < READABLE_COUNT; i++) {
    const sid = `sessP${i}`;
    const base = { sessionId: sid, cwd: '/tmp/projP', gitBranch: 'main', version: '2.1.0' };
    writeFileSync(
      join(proj, `${sid}.jsonl`),
      jsonl([
        { ...base, type: 'user', uuid: `p${i}-u1`, parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: `hello ${i}` } },
        { ...base, type: 'assistant', uuid: `p${i}-a1`, parentUuid: `p${i}-u1`, timestamp: '2026-01-01T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 5 } } },
      ]),
    );
  }
  if (canMakeUnreadable) {
    const bad = join(proj, 'sessP-unreadable.jsonl');
    writeFileSync(bad, jsonl([{ type: 'user', sessionId: 'bad' }]));
    chmodSync(bad, 0o000);
  }
}

const expectedTotal = READABLE_COUNT + (canMakeUnreadable ? 1 : 0);

let app: FastifyInstance;
let reindex: typeof import('../src/data/index.js').reindex;
let getIndexProgress: typeof import('../src/data/index.js').getIndexProgress;
let getConnection: typeof import('../src/db/duckdb.js').getConnection;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  writeFixtures();
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  ({ reindex, getIndexProgress } = await import('../src/data/index.js'));
  ({ getConnection, closeConnection, queryRows } = await import('../src/db/duckdb.js'));
  app = Fastify();
  await registerRoutes(app);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('first build', () => {
  it('exposes monotonic progress, counts skipped files, and grows sessions mid-pass', async () => {
    const conn = await getConnection();

    const samples: { processed: number; total: number }[] = [];
    const midPassSessionCounts: number[] = [];
    let resolved = false;
    const run = reindex().then((r) => {
      resolved = true;
      return r;
    });

    // Sample once per event-loop turn while the pass runs — progress from
    // memory every turn, the derived sessions count every few turns (a live
    // query on the same connection, exactly what /api/projects does).
    let turn = 0;
    while (!resolved) {
      const p = getIndexProgress();
      if (p) samples.push({ ...p });
      if (turn % 5 === 0) {
        const rows = await queryRows(conn, 'SELECT count(*) AS n FROM sessions');
        if (!resolved) midPassSessionCounts.push(Number(rows[0]?.n ?? 0));
      }
      turn += 1;
      await new Promise((r) => setImmediate(r));
    }
    const result = await run;

    // The pass reported a stable total and a non-decreasing counter.
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.total === expectedTotal)).toBe(true);
    let prev = 0;
    for (const s of samples) {
      expect(s.processed).toBeGreaterThanOrEqual(prev);
      expect(s.processed).toBeLessThanOrEqual(s.total);
      prev = s.processed;
    }
    // Progress stays visible through finalization at processed === total —
    // which also proves the skipped unreadable file advanced the counter.
    expect(samples.at(-1)?.processed).toBe(expectedTotal);
    // Cleared once the pass ends; only readable files were indexed.
    expect(getIndexProgress()).toBeNull();
    expect(result.reindexed).toBe(READABLE_COUNT);

    // The partial finalization made sessions visible before the pass finished.
    expect(midPassSessionCounts.some((n) => n > 0)).toBe(true);

    const rows = await queryRows(conn, 'SELECT count(*) AS n FROM sessions');
    expect(Number(rows[0]?.n ?? 0)).toBe(READABLE_COUNT);
  });
});

/** Run a pass while sampling progress; returns the samples and the result. */
async function samplePass(): Promise<{ seen: unknown[]; reindexed: number }> {
  let resolved = false;
  const run = reindex().then((r) => {
    resolved = true;
    return r;
  });
  const seen: unknown[] = [];
  while (!resolved) {
    const p = getIndexProgress();
    if (p) seen.push(p);
    await new Promise((r) => setImmediate(r));
  }
  const result = await run;
  return { seen, reindexed: result.reindexed };
}

describe('passes with nothing to load', () => {
  it('removal-only and no-change passes expose no progress; /api/health carries no indexing key', async () => {
    // The never-loaded unreadable file has no `files` row, so it stays in the
    // changed set every pass (deliberate: a later edit retries it). Remove it
    // to reach a stable state; the removal pass itself has an empty changed
    // set, so it must not surface a "0 of 0" progress object either.
    if (canMakeUnreadable) {
      rmSync(join(projectsDir, 'enc-projP', 'sessP-unreadable.jsonl'), { force: true });
      const removal = await samplePass();
      expect(removal.seen).toEqual([]);
      expect(removal.reindexed).toBe(0);
    }

    // Truly idle pass: nothing discovered as changed, nothing removed.
    const idle = await samplePass();
    expect(idle.seen).toEqual([]);
    expect(idle.reindexed).toBe(0);

    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toMatchObject({ status: 'ok', ready: true });
    expect(json.indexing).toBeUndefined();
  });
});
