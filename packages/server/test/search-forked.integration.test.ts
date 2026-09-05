/**
 * Full-text search over a corpus containing fork/resume copies.
 *
 * `events.uuid` is NOT unique: forking or resuming a session copies the whole
 * history into a new file with the uuids preserved, so the same uuid exists under
 * two session ids. `match_bm25` looks its document up by the FTS key with a
 * scalar subquery, so a uuid-keyed index returned multiple rows there — which
 * newer DuckDB raises `More than one row returned by a subquery` for.
 *
 * The fix is a key that really is unique per row (`events.doc_id`), not a
 * connection-wide `scalar_subquery_error_on_multiple_rows = false` that would
 * turn every genuine multi-row scalar subquery in the app into a silent
 * arbitrary pick. This asserts both halves: the key is distinct per row, the
 * shared connection keeps the strict default, and search still crosses forks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-searchfork-'));
const projectsDir = join(work, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
for (const v of [
  'CODEX_SESSIONS_DIR',
  'JUNIE_SESSIONS_DIR',
  'PI_SESSIONS_DIR',
  'OPENCODE_DATA_DIR',
  'COPILOT_SESSIONS_DIR',
  'ANTIGRAVITY_CLI_DIR',
  'ANTIGRAVITY_DIR',
  'GROK_SESSIONS_DIR',
]) {
  process.env[v] = join(work, `${v.toLowerCase()}-empty`);
}
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

/** A rare token so the BM25 hit is unambiguous. */
const NEEDLE = 'xyzzyplugh';

/**
 * An original session plus a fork of it. The fork preserves every uuid (that is
 * what makes this the interesting case) and rewrites only the session id.
 */
function writeFixtures(): void {
  const proj = join(projectsDir, 'enc-projS');
  mkdirSync(proj, { recursive: true });

  const lines = (sessionId: string, forked: boolean): string =>
    [
      {
        sessionId,
        cwd: '/tmp/projS',
        type: 'user',
        uuid: 'shared-u1',
        parentUuid: null,
        timestamp: '2026-04-01T10:00:00.000Z',
        isSidechain: false,
        message: { role: 'user', content: `please find ${NEEDLE} in here` },
        ...(forked ? { forkedFrom: { sessionId: 'sessOrig', messageUuid: 'shared-u1' } } : {}),
      },
      {
        sessionId,
        cwd: '/tmp/projS',
        type: 'assistant',
        uuid: 'shared-a1',
        parentUuid: 'shared-u1',
        timestamp: '2026-04-01T10:00:01.000Z',
        isSidechain: false,
        message: {
          role: 'assistant',
          id: 'msg_shared',
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: `found ${NEEDLE} for you` }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        ...(forked ? { forkedFrom: { sessionId: 'sessOrig', messageUuid: 'shared-a1' } } : {}),
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n';

  writeFileSync(join(proj, 'sessOrig.jsonl'), lines('sessOrig', false));
  writeFileSync(join(proj, 'sessFork.jsonl'), lines('sessFork', true));
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;

beforeAll(async () => {
  writeFixtures();
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');
  const duck = await import('../src/db/duckdb.js');
  ({ closeConnection, queryRows } = duck);
  app = Fastify();
  await registerRoutes(app);
  await reindex();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('a duplicated events.uuid', () => {
  it('really is present — the precondition for the multi-row lookup', async () => {
    const conn = await (await import('../src/db/duckdb.js')).getConnection();
    const rows = await queryRows(
      conn,
      "SELECT uuid, count(*) AS n FROM events WHERE uuid = 'shared-a1' GROUP BY uuid",
    );
    expect(Number(rows[0]?.n)).toBe(2);
  });

  it('still yields a doc_id that is unique per row — the FTS key', async () => {
    const conn = await (await import('../src/db/duckdb.js')).getConnection();
    const rows = await queryRows(
      conn,
      'SELECT count(*) AS n, count(DISTINCT doc_id) AS distinct_ids FROM events',
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
    expect(Number(rows[0]?.distinct_ids)).toBe(Number(rows[0]?.n));
  });
});

describe('the shared connection', () => {
  it('keeps scalar subqueries strict — no connection-wide relaxation', async () => {
    const conn = await (await import('../src/db/duckdb.js')).getConnection();
    const rows = await queryRows(
      conn,
      "SELECT current_setting('scalar_subquery_error_on_multiple_rows') AS strict",
    );
    expect(rows[0]?.strict).toBe(true);
  });
});

describe('GET /api/search over forked sessions', () => {
  it('returns hits instead of failing on the multi-row subquery', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/search?q=${NEEDLE}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The route catches its own errors and returns [], so an empty list is how a
    // broken FTS lookup shows up here — assert we actually got hits.
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.sessions[0].snippet).toContain('<mark>');
    // Both copies are their own documents under the per-row key, so neither the
    // original nor the fork is swallowed by the other.
    const hitSessions = new Set(body.sessions.map((s: { sessionId: string }) => s.sessionId));
    expect(hitSessions).toEqual(new Set(['sessOrig', 'sessFork']));
  });

  it('works on a connection that has served no prior search', async () => {
    // A search must never depend on some earlier query having prepared the
    // connection for it. Search from a second app on the same (already-open)
    // connection, which the first test has since used, to keep that honest.
    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes/index.js');
    const fresh = Fastify();
    await registerRoutes(fresh);
    await fresh.ready();
    const res = await fresh.inject({ method: 'GET', url: `/api/search?q=${NEEDLE}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions.length).toBeGreaterThan(0);
    await fresh.close();
  });
});
