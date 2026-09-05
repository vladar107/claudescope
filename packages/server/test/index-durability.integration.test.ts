/**
 * Indexer durability — the failure paths that used to lose data silently.
 *
 * `loadFile` replaces a file's rows by delete-then-insert. Previously the insert
 * came *after* the deletes, so anything that broke while projecting destroyed the
 * file's indexed events — and the pass still returned `{reindexed: 0}`, which is
 * exactly what an idle pass returns, so nothing reported a problem. Two layers
 * now cover that, tested separately here:
 *
 *  - `loadPricing` validation, which stops the most likely trigger: a rate typed
 *    as a string in the USER-EDITABLE `pricing.json` (it is string-interpolated
 *    into the cost expression, so a bad value yields invalid SQL);
 *  - staging in `loadFile`, which makes ANY projection failure non-destructive —
 *    covering triggers validation can't foresee (here: an unreadable source
 *    file) — plus the `failed` counter that stops a failing pass from passing
 *    for an idle one.
 *
 * The concurrency case is a regression guard: an earlier attempt wrapped the
 * load in an explicit transaction, which swept in — and aborted — queries the
 * HTTP routes issue on the shared connection while a pass runs.
 *
 * Uses a throwaway projects dir + DuckDB in a temp dir; never touches any real
 * agent source.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { PricingConfig, ReindexResponse } from '@claudescope/shared';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-durability-'));
const projectsDir = join(work, 'projects');
const pricingPath = join(work, 'pricing.json');

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
process.env.PRICING_PATH = pricingPath;
process.env.REINDEX_INTERVAL_MS = '0';

/** chmod(000) only bites for a non-root POSIX user. */
const canMakeUnreadable =
  process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

const projDir = join(projectsDir, 'enc-projD');
const keepFile = join(projDir, 'sessKeep.jsonl');

/** One assistant turn. `model` is unlisted so it prices via `default`. */
const row = (session: string, uuid: string, cwd = '/tmp/projD'): string =>
  JSON.stringify({
    sessionId: session,
    cwd,
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp: '2026-01-01T10:00:00.000Z',
    isSidechain: false,
    message: {
      role: 'assistant',
      id: `msg-${uuid}`,
      model: 'some-unlisted-model',
      content: [{ type: 'text', text: `turn ${uuid}` }],
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    },
  }) + '\n';

/** Unique term for the FTS assertion below — must not collide with any other
 *  fixture's prose in this file. */
const UNIQUE_WORD = 'zzyzxquokka';

/**
 * A user turn (carrying {@link UNIQUE_WORD}) followed by an Edit tool call and
 * its result — exercises `sessions`, `file_edits`, and FTS in one fixture, all
 * of which only get (re)built by `doReindex`'s finalize step.
 */
const editSessionLines = (session: string, cwd = '/tmp/projE'): string => {
  const base = { sessionId: session, cwd, isSidechain: false };
  const lines = [
    {
      ...base,
      type: 'user',
      uuid: 'eu1',
      parentUuid: null,
      timestamp: '2026-01-01T11:00:00.000Z',
      message: { role: 'user', content: `please handle ${UNIQUE_WORD} now` },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'ea1',
      parentUuid: 'eu1',
      timestamp: '2026-01-01T11:00:01.000Z',
      message: {
        role: 'assistant',
        id: 'msg-ea1',
        model: 'some-unlisted-model',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_e1',
            name: 'Edit',
            input: { file_path: `${cwd}/src/app.ts`, old_string: 'one', new_string: 'ONE' },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    },
    {
      ...base,
      type: 'user',
      uuid: 'eu2',
      parentUuid: 'ea1',
      timestamp: '2026-01-01T11:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_e1', content: 'ok' }] },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
};

/** `default.input` is injectable so a test can make it unusable. */
const pricingWith = (defaultInput: unknown): string =>
  JSON.stringify(
    {
      schemaVersion: 4,
      models: {},
      families: {},
      providers: {},
      default: { input: defaultInput, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    } as unknown as PricingConfig,
    null,
    2,
  );

let reindex: () => Promise<ReindexResponse>;
let failNextFinalizeForTests: () => void;
let conn: DuckDBConnection;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let sqlString: typeof import('../src/db/duckdb.js').sqlString;
let closeConnection: () => Promise<void>;

const countEvents = async (file?: string): Promise<number> => {
  const where = file ? ` WHERE file_path = '${file}'` : '';
  return Number((await queryRows(conn, `SELECT count(*) AS n FROM events${where}`))[0]?.n ?? 0);
};

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

beforeAll(async () => {
  mkdirSync(projDir, { recursive: true });
  mkdirSync(join(work, 'home'), { recursive: true });
  writeFileSync(pricingPath, pricingWith(3));
  writeFileSync(keepFile, row('sessKeep', 'k1') + row('sessKeep', 'k2') + row('sessKeep', 'k3'));

  ({ reindex, failNextFinalizeForTests } = await import('../src/data/index.js'));
  const duck = await import('../src/db/duckdb.js');
  ({ queryRows, sqlString, closeConnection } = duck);
  conn = await duck.getConnection();
});

afterAll(async () => {
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('an unusable rate in the user-editable pricing.json', () => {
  it('is dropped rather than breaking the load', async () => {
    const first = await reindex();
    expect(first.reindexed).toBe(1);
    expect(first.failed).toBe(0);
    // 1M input tokens at $3/MTok.
    const before = await queryRows(conn, "SELECT sum(cost_usd) AS c FROM events WHERE session_id = 'sessKeep'");
    expect(Number(before[0]?.c ?? 0)).toBeCloseTo(9, 6);

    // The plausible hand-edit: a rate with a unit suffix. Interpolated into the
    // cost expression, this used to produce invalid SQL and destroy the rows.
    writeFileSync(pricingPath, pricingWith('3.00 USD'));
    appendFileSync(keepFile, row('sessKeep', 'k4'));

    const pass = await reindex();
    expect(pass.failed).toBe(0);
    expect(pass.reindexed).toBe(1);
    expect(await countEvents()).toBe(4);
    // The unusable `default.input` is treated as 0 — visibly wrong, not fatal.
    const after = await queryRows(conn, "SELECT sum(cost_usd) AS c FROM events WHERE session_id = 'sessKeep'");
    expect(Number(after[0]?.c ?? 0)).toBe(0);

    writeFileSync(pricingPath, pricingWith(3));
    await reindex();
  });
});

describe('a projection failure validation cannot foresee', () => {
  it.skipIf(!canMakeUnreadable)(
    'leaves the previously indexed rows intact and reports `failed`',
    async () => {
      const doomed = join(projDir, 'sessDoomed.jsonl');
      writeFileSync(doomed, row('sessDoomed', 'x1') + row('sessDoomed', 'x2'));
      const indexed = await reindex();
      expect(indexed.failed).toBe(0);
      expect(await countEvents(doomed)).toBe(2);

      // Grow the file so it lands in the changed set, then make it unreadable —
      // the projection now fails with an IO error mid-load.
      appendFileSync(doomed, row('sessDoomed', 'x3'));
      chmodSync(doomed, 0o000);

      const failedPass = await reindex();

      // The rows it could not re-read are still there (staging never deleted them).
      expect(await countEvents(doomed)).toBe(2);
      // Other files are untouched.
      expect(await countEvents(keepFile)).toBe(4);
      // And the pass is not reported as a clean idle one.
      expect(failedPass.reindexed).toBe(0);
      expect(failedPass.failed).toBe(1);

      // Readable again → the pass recovers and picks up the appended turn.
      chmodSync(doomed, 0o644);
      const recovered = await reindex();
      expect(recovered.failed).toBe(0);
      expect(recovered.reindexed).toBe(1);
      expect(await countEvents(doomed)).toBe(3);

      rmSync(doomed, { force: true });
      await reindex();
    },
  );

  it.skipIf(!canMakeUnreadable)(
    'does not disturb concurrent route-style queries on the shared connection',
    async () => {
      const doomed = join(projDir, 'sessConcurrent.jsonl');
      writeFileSync(doomed, row('sessConcurrent', 'c1'));
      await reindex();
      appendFileSync(doomed, row('sessConcurrent', 'c2'));
      chmodSync(doomed, 0o000);

      let done = false;
      const pass = reindex().then((r) => {
        done = true;
        return r;
      });

      // Exactly what /api/projects does while a pass runs, on the same connection.
      const errors: unknown[] = [];
      while (!done) {
        try {
          await queryRows(conn, 'SELECT count(*) AS n FROM sessions');
        } catch (err) {
          errors.push(err);
        }
        await new Promise((r) => setImmediate(r));
      }
      const result = await pass;

      expect(result.failed).toBe(1);
      expect(errors).toEqual([]);

      chmodSync(doomed, 0o644);
      rmSync(doomed, { force: true });
      await reindex();
    },
  );
});

describe('a finalize failure after `files` bookkeeping already advanced', () => {
  it('is repaired by the next pass even with no further file changes', async () => {
    const editFile = join(projDir, 'sessEdit.jsonl');
    writeFileSync(editFile, editSessionLines('sessEdit'));

    failNextFinalizeForTests();
    await expect(reindex()).rejects.toThrow('injected finalize failure');

    // `files`/`events` already reflect the new file (staged before finalize
    // ran), but the derived tables the finalize step owns do not yet.
    expect(await countEvents(editFile)).toBe(3);
    const beforeSessions = await queryRows(conn, "SELECT count(*) AS n FROM sessions WHERE id = 'sessEdit'");
    expect(Number(beforeSessions[0]?.n ?? 0)).toBe(0);

    // No further file changes on disk — this must NOT read as an idle pass.
    const recovered = await reindex();
    expect(recovered.reindexed).toBe(0);
    expect(recovered.failed).toBe(0);

    const sessions = await queryRows(conn, "SELECT count(*) AS n FROM sessions WHERE id = 'sessEdit'");
    expect(Number(sessions[0]?.n ?? 0)).toBe(1);
    const edits = await queryRows(
      conn,
      "SELECT count(*) AS n FROM file_edits WHERE session_id = 'sessEdit' AND edit_canonical",
    );
    expect(Number(edits[0]?.n ?? 0)).toBe(1);
    expect(await ftsFinds(UNIQUE_WORD, 'sessEdit')).toBe(true);
  });
});

describe('modal project cwd', () => {
  it('resolves a perfect cwd tie deterministically', async () => {
    // Two cwds with an identical event count: without a tie-break column the
    // window function is free to pick either, and it did flip between
    // evaluations — moving the session (and its cost) between projects.
    const tied = join(projDir, 'tie.jsonl');
    writeFileSync(
      tied,
      ['t1', 't2', 't3'].map((u) => row('tie', u, '/tmp/aaa')).join('') +
        ['t4', 't5', 't6'].map((u) => row('tie', u, '/tmp/bbb')).join(''),
    );
    await reindex();

    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const rows = await queryRows(
        conn,
        `SELECT session_id, cwd FROM (
           SELECT session_id, cwd,
                  row_number() OVER (PARTITION BY session_id ORDER BY count(*) DESC, cwd) AS rn
           FROM events WHERE cwd IS NOT NULL GROUP BY session_id, cwd
         ) WHERE rn = 1 AND session_id = 'tie'`,
      );
      seen.add(String(rows[0]?.cwd ?? 'none'));
    }
    expect([...seen]).toEqual(['/tmp/aaa']);

    // The derived table agrees with the CTE.
    const s = await queryRows(conn, "SELECT project_cwd FROM sessions WHERE id = 'tie'");
    expect(String(s[0]?.project_cwd)).toBe('/tmp/aaa');
  });
});
