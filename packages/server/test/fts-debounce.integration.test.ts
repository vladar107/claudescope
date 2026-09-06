/**
 * FTS rebuild debounce — the rule is "a debounce never loses a rebuild".
 *
 * Rebuilding the BM25 index from scratch plus a CHECKPOINT on every pass that
 * loaded a file makes an active agent stall every route query on the shared
 * connection once per poll. The rebuild is therefore debounced with a trailing
 * edge (`FTS_REBUILD_MIN_INTERVAL_MS`) and a PERSISTED `meta.fts_stale` flag.
 * Persisted, because an in-memory flag is lost by a restart mid-session
 * (`claudescope update`, the version-skew self-restart) and the idle
 * early-return would then never notice the index is behind.
 *
 * What is asserted here is only the skip path: the derived tables stay fresh
 * while FTS is skipped, the flag records the debt, and every route back to a
 * rebuild pays it — an idle pass, a pass in a fresh process, and an explicit
 * flush. With the interval at `0` (the vitest default) every pass rebuilds, and
 * the rest of the suite already asserts search right after a pass; that case is
 * deliberately not duplicated here.
 *
 * Uses a throwaway projects dir + DuckDB in a temp dir; never touches any real
 * agent source.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { FastifyInstance } from 'fastify';
import type { ReindexResponse } from '@claudescope/shared';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-fts-debounce-'));
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
// A window no test can cross by elapsing, so every rebuild after the first is
// one the debounce had to be told about. Read at module load, so it must be set
// before the first dynamic import below (and it overrides the vitest env pin).
process.env.FTS_REBUILD_MIN_INTERVAL_MS = '3600000';

const projDir = join(projectsDir, 'enc-projFts');

/** Distinct nonsense terms, one per session, so a hit names its session. */
const WORDS = { a: 'quokkazero', b: 'quokkaone', c: 'quokkatwo', d: 'quokkathree' } as const;

/** A one-turn Claude Code transcript whose prose carries `word`. */
const writeSession = (session: string, word: string): void => {
  const base = { sessionId: session, cwd: '/tmp/projFts', isSidechain: false };
  const lines = [
    {
      ...base,
      type: 'user',
      uuid: `${session}-u1`,
      parentUuid: null,
      timestamp: '2026-01-01T10:00:00.000Z',
      message: { role: 'user', content: `please handle ${word} now` },
    },
    {
      ...base,
      type: 'assistant',
      uuid: `${session}-a1`,
      parentUuid: `${session}-u1`,
      timestamp: '2026-01-01T10:00:01.000Z',
      message: {
        role: 'assistant',
        id: `msg-${session}-a1`,
        model: 'some-unlisted-model',
        content: [{ type: 'text', text: `done with ${word}` }],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    },
  ];
  writeFileSync(join(projDir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

let reindex: (opts?: { flushFts?: boolean }) => Promise<ReindexResponse>;
let conn: DuckDBConnection;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let sqlString: typeof import('../src/db/duckdb.js').sqlString;
let closeConnection: () => Promise<void>;

/** (Re)import the indexer + db modules, as a fresh process would. */
async function loadServerModules(): Promise<void> {
  ({ reindex } = await import('../src/data/index.js'));
  const duck = await import('../src/db/duckdb.js');
  ({ queryRows, sqlString, closeConnection } = duck);
  conn = await duck.getConnection();
}

/** Whether the BM25 index over `events.text_content` finds `term` in `sessionId`. */
const ftsFinds = async (term: string, sessionId: string): Promise<boolean> => {
  const rows = await queryRows(
    conn,
    `SELECT session_id FROM (
       SELECT session_id, fts_main_events.match_bm25(doc_id, ${sqlString(term)}) AS score
       FROM events WHERE text_content IS NOT NULL
     ) WHERE score IS NOT NULL AND session_id = ${sqlString(sessionId)}`,
  );
  return rows.length > 0;
};

/** The persisted staleness flag, or null when the key is absent. */
const ftsStaleFlag = async (): Promise<string | null> => {
  const rows = await queryRows(conn, "SELECT value FROM meta WHERE key = 'fts_stale'");
  return rows.length > 0 ? String(rows[0]?.value) : null;
};

/** Whether the derived `sessions` table (never debounced) has the row. */
const sessionIndexed = async (id: string): Promise<boolean> => {
  const rows = await queryRows(conn, `SELECT id FROM sessions WHERE id = ${sqlString(id)}`);
  return rows.length > 0;
};

beforeAll(async () => {
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(work, 'home'), { recursive: true });
  await loadServerModules();
});

afterAll(async () => {
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('the FTS rebuild debounce', () => {
  it('rebuilds on the first pass of a process', async () => {
    writeSession('ftsA', WORDS.a);
    const pass = await reindex();
    expect(pass.reindexed).toBe(1);
    expect(await ftsFinds(WORDS.a, 'ftsA')).toBe(true);
    expect(await ftsStaleFlag()).toBeNull();
  });

  it('skips the rebuild inside the window but keeps the derived tables fresh', async () => {
    writeSession('ftsB', WORDS.b);
    const pass = await reindex();
    expect(pass.reindexed).toBe(1);

    // `sessions` is what the list page watches live — never debounced.
    expect(await sessionIndexed('ftsB')).toBe(true);
    // Ranked search lags; the debt is recorded rather than forgotten.
    expect(await ftsFinds(WORDS.b, 'ftsB')).toBe(false);
    expect(await ftsStaleFlag()).toBe('1');
  });

  it('pays the debt on the next idle pass and clears the flag', async () => {
    const pass = await reindex();
    expect(pass.reindexed).toBe(0);
    expect(pass.failed).toBe(0);
    expect(await ftsFinds(WORDS.b, 'ftsB')).toBe(true);
    expect(await ftsStaleFlag()).toBeNull();
  });

  it('pays a debt recorded before a restart, on the first pass after it', async () => {
    writeSession('ftsC', WORDS.c);
    await reindex();
    expect(await ftsFinds(WORDS.c, 'ftsC')).toBe(false);
    expect(await ftsStaleFlag()).toBe('1');

    // Simulate `claudescope update` / the version-skew self-restart: the
    // in-memory flag is gone, and nothing on disk has changed since.
    await closeConnection();
    vi.resetModules();
    await loadServerModules();

    const pass = await reindex();
    expect(pass.reindexed).toBe(0);
    expect(await ftsFinds(WORDS.c, 'ftsC')).toBe(true);
    expect(await ftsStaleFlag()).toBeNull();
  });

  it('flushes on request, without waiting for the window', async () => {
    writeSession('ftsD', WORDS.d);
    await reindex();
    expect(await ftsFinds(WORDS.d, 'ftsD')).toBe(false);

    await reindex({ flushFts: true });
    expect(await ftsFinds(WORDS.d, 'ftsD')).toBe(true);
    expect(await ftsStaleFlag()).toBeNull();
  });

  it('flushes for POST /api/reindex — a user-initiated pass expects fresh search', async () => {
    const session = 'ftsE';
    const word = 'quokkafour';
    writeSession(session, word);
    await reindex();
    expect(await ftsFinds(word, session)).toBe(false);

    const Fastify = (await import('fastify')).default;
    const { registerRoutes } = await import('../src/routes/index.js');
    const app: FastifyInstance = Fastify();
    await registerRoutes(app);
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/reindex' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }

    expect(await ftsFinds(word, session)).toBe(true);
    expect(await ftsStaleFlag()).toBeNull();
  });
});
