/**
 * Full-text search over a corpus containing fork/resume copies.
 *
 * `events.uuid` is NOT unique: forking or resuming a session copies the whole
 * history into a new file with the uuids preserved, so the same uuid exists under
 * two session ids. `fts_main_events.match_bm25(uuid, …)` looks the document up by
 * that key with a scalar subquery, which therefore returns multiple rows — and
 * newer DuckDB raises `More than one row returned by a subquery` for that.
 *
 * The search route relies on `scalar_subquery_error_on_multiple_rows = false` to
 * keep working (the duplicates are identical copies, so picking either is fine).
 * Nothing tested that: deleting the setting outright left the whole suite green,
 * which meant the one reason it exists was unverified — and it is a
 * connection-level setting on the connection the indexer shares, so where it gets
 * applied matters.
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
  });

  it('works on a connection that has served no prior search', async () => {
    // The setting used to be applied inside the search handler, so the FIRST
    // search on a fresh process was the one that armed it. Sequencing that way
    // means a different first query could have hit the error instead. Search from
    // a second app on the same (already-open) connection to make the point that
    // the setting is a property of the connection, not of having searched before.
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
