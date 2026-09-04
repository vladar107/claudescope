/**
 * Compactions + context-size indexing — the edges the derivation can get wrong.
 *
 * A synthetic ~/.claude/projects tree is indexed into a throwaway DuckDB and the
 * `compactions` / `sessions` tables are read directly, because these are index
 * facts (the API layer only maps them).
 *
 *  1. The boundary-or-summary rule: current Claude Code writes a
 *     `compact_boundary` system row, the 2025 format flagged the summary user
 *     turn with `isCompactSummary`, and a transition-period file carries BOTH
 *     for ONE compaction — which must not count twice, while a file with only
 *     the flag must still count.
 *  2. Subagent compactions are recorded (their own thread shows them) but stay
 *     out of the session's main-thread count.
 *  3. Context = the prompt size of the LAST main-thread turn, not the peak: a
 *     sawtooth session's earlier turn is larger, the final billed call is split
 *     over two rows sharing one usage object, and a later sidechain turn is
 *     irrelevant. No usage at all → NULL, not 0.
 *  4. Compaction rows are keyed by FILE, not by session: reloading the parent
 *     transcript must not drop the subagent file's row (they share a session
 *     id), and removing a file must drop exactly its rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { FastifyInstance } from 'fastify';
import type {
  ReindexResponse,
  SessionEfficiencyResponse,
  SessionMeta,
} from '@claudescope/shared';

const work = mkdtempSync(join(tmpdir(), 'claudescope-compact-'));
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
// A base pricing whose `sonnet` family (and nothing else) knows its window.
process.env.PRICING_PATH = join(work, 'pricing.json');

const CWD = '/tmp/compactproj';
const OPUS = 'claude-opus-4-8';
const SONNET = 'claude-sonnet-4-9';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

const user = (
  uuid: string,
  sessionId: string,
  ts: string,
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'user', uuid, parentUuid: null, sessionId, timestamp: ts, cwd: CWD,
  isSidechain: false, message: { role: 'user', content: text }, ...extra,
});

/** One assistant turn. `prompt` is split across input/cache-read (their sum is the context). */
function asst(opts: {
  uuid: string;
  sessionId: string;
  ts: string;
  messageId: string;
  prompt: number;
  model?: string;
  sidechain?: boolean;
}): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: opts.uuid,
    parentUuid: null,
    sessionId: opts.sessionId,
    timestamp: opts.ts,
    cwd: CWD,
    isSidechain: opts.sidechain ?? false,
    message: {
      id: opts.messageId,
      role: 'assistant',
      model: opts.model ?? OPUS,
      content: [{ type: 'text', text: `reply ${opts.uuid}` }],
      usage: {
        input_tokens: opts.prompt > 0 ? 100 : 0,
        output_tokens: 20,
        cache_read_input_tokens: opts.prompt > 0 ? opts.prompt - 100 : 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

/** A current-format `compact_boundary` system record. */
const boundary = (opts: {
  uuid: string;
  sessionId: string;
  ts: string;
  trigger: string;
  pre: number;
  post: number;
  sidechain?: boolean;
}): Record<string, unknown> => ({
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  level: 'info',
  uuid: opts.uuid,
  parentUuid: null,
  sessionId: opts.sessionId,
  timestamp: opts.ts,
  cwd: CWD,
  isSidechain: opts.sidechain ?? false,
  compactMetadata: {
    trigger: opts.trigger,
    preTokens: opts.pre,
    postTokens: opts.post,
    cumulativeDroppedTokens: opts.pre - opts.post,
  },
});

/** The 2025 format's marker: the summary turn itself, flagged. */
const summaryTurn = (uuid: string, sessionId: string, ts: string, sidechain = false) =>
  user(uuid, sessionId, ts, 'This session is being continued from a previous conversation…', {
    isCompactSummary: true,
    isSidechain: sidechain,
  });

const proj = join(projectsDir, 'enc-compactproj');
const boundaryOnlyFile = join(proj, 'boundaryOnly.jsonl');
const summaryOnlyFile = join(proj, 'summaryOnly.jsonl');
const withSubFile = join(proj, 'withSub.jsonl');
const subagentFile = join(proj, 'withSub', 'subagents', 'agent-x.jsonl');

function writeFixtures(): void {
  mkdirSync(join(proj, 'withSub', 'subagents'), { recursive: true });
  const rate = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };
  writeFileSync(
    process.env.PRICING_PATH!,
    JSON.stringify({
      models: {},
      families: { sonnet: { ...rate, contextWindow: 200000 }, opus: rate },
      default: rate,
    }),
  );

  // Two boundaries, both with metadata.
  writeFileSync(boundaryOnlyFile, jsonl([
    user('b-u1', 'boundaryOnly', '2026-03-01T10:00:00.000Z', 'hi'),
    asst({ uuid: 'b-a1', sessionId: 'boundaryOnly', ts: '2026-03-01T10:00:01.000Z', messageId: 'b1', prompt: 200000 }),
    boundary({ uuid: 'b-c1', sessionId: 'boundaryOnly', ts: '2026-03-01T10:00:02.000Z', trigger: 'manual', pre: 331954, post: 17672 }),
    asst({ uuid: 'b-a2', sessionId: 'boundaryOnly', ts: '2026-03-01T10:00:03.000Z', messageId: 'b2', prompt: 40000 }),
    boundary({ uuid: 'b-c2', sessionId: 'boundaryOnly', ts: '2026-03-01T10:00:04.000Z', trigger: 'auto', pre: 300000, post: 15000 }),
  ]));

  // Transition-period file: ONE compaction written as both markers.
  writeFileSync(join(proj, 'bothMarkers.jsonl'), jsonl([
    user('m-u1', 'bothMarkers', '2026-03-02T10:00:00.000Z', 'hi'),
    asst({ uuid: 'm-a1', sessionId: 'bothMarkers', ts: '2026-03-02T10:00:01.000Z', messageId: 'm1', prompt: 150000 }),
    summaryTurn('m-s1', 'bothMarkers', '2026-03-02T10:00:02.000Z'),
    boundary({ uuid: 'm-c1', sessionId: 'bothMarkers', ts: '2026-03-02T10:00:03.000Z', trigger: 'manual', pre: 150000, post: 9000 }),
  ]));

  // 2025 format: the flag is the only marker there is.
  writeFileSync(summaryOnlyFile, jsonl([
    user('s-u1', 'summaryOnly', '2026-03-03T10:00:00.000Z', 'hi'),
    asst({ uuid: 's-a1', sessionId: 'summaryOnly', ts: '2026-03-03T10:00:01.000Z', messageId: 's1', prompt: 120000 }),
    summaryTurn('s-s1', 'summaryOnly', '2026-03-03T10:00:02.000Z'),
  ]));

  // Main transcript + a subagent transcript that compacted too (same session id).
  writeFileSync(withSubFile, jsonl([
    user('w-u1', 'withSub', '2026-03-04T10:00:00.000Z', 'hi'),
    asst({ uuid: 'w-a1', sessionId: 'withSub', ts: '2026-03-04T10:00:01.000Z', messageId: 'w1', prompt: 90000 }),
    boundary({ uuid: 'w-c1', sessionId: 'withSub', ts: '2026-03-04T10:00:02.000Z', trigger: 'manual', pre: 90000, post: 8000 }),
  ]));
  writeFileSync(subagentFile, jsonl([
    { ...user('w-su1', 'withSub', '2026-03-04T10:00:03.000Z', 'do the thing'), isSidechain: true },
    asst({ uuid: 'w-sa1', sessionId: 'withSub', ts: '2026-03-04T10:00:04.000Z', messageId: 'ws1', prompt: 250000, sidechain: true }),
    boundary({ uuid: 'w-sc1', sessionId: 'withSub', ts: '2026-03-04T10:00:05.000Z', trigger: 'auto', pre: 250000, post: 12000, sidechain: true }),
  ]));

  // Sawtooth: the peak (200k) is NOT the answer; the last billed call is written
  // as two block rows sharing one usage; a later sidechain turn is ignored.
  writeFileSync(join(proj, 'sawtooth.jsonl'), jsonl([
    user('t-u1', 'sawtooth', '2026-03-05T10:00:00.000Z', 'hi'),
    asst({ uuid: 't-a1', sessionId: 'sawtooth', ts: '2026-03-05T10:00:01.000Z', messageId: 't1', prompt: 5000 }),
    asst({ uuid: 't-a2', sessionId: 'sawtooth', ts: '2026-03-05T10:00:02.000Z', messageId: 't2', prompt: 200000 }),
    asst({ uuid: 't-a3', sessionId: 'sawtooth', ts: '2026-03-05T10:00:03.000Z', messageId: 't3', prompt: 30000, model: SONNET }),
    asst({ uuid: 't-a4', sessionId: 'sawtooth', ts: '2026-03-05T10:00:03.000Z', messageId: 't3', prompt: 30000, model: SONNET }),
    asst({ uuid: 't-s1', sessionId: 'sawtooth', ts: '2026-03-05T10:00:09.000Z', messageId: 't4', prompt: 999999, sidechain: true }),
  ]));

  // Output-only usage: no prompt was billed, so there is no known context.
  writeFileSync(join(proj, 'noUsage.jsonl'), jsonl([
    user('n-u1', 'noUsage', '2026-03-06T10:00:00.000Z', 'hi'),
    asst({ uuid: 'n-a1', sessionId: 'noUsage', ts: '2026-03-06T10:00:01.000Z', messageId: 'n1', prompt: 0 }),
  ]));
}

let reindex: () => Promise<ReindexResponse>;
let conn: DuckDBConnection;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let closeConnection: () => Promise<void>;
let app: FastifyInstance;

const compactionsOf = async (filePath: string): Promise<Record<string, unknown>[]> =>
  queryRows(
    conn,
    `SELECT * FROM compactions WHERE file_path = '${filePath}' ORDER BY ts`,
  );

const sessionRow = async (id: string): Promise<Record<string, unknown> | undefined> =>
  (
    await queryRows(
      conn,
      `SELECT compaction_count, context_tokens, context_model FROM sessions WHERE id = '${id}'`,
    )
  )[0];

beforeAll(async () => {
  writeFixtures();
  ({ reindex } = await import('../src/data/index.js'));
  const duck = await import('../src/db/duckdb.js');
  ({ queryRows, closeConnection } = duck);
  conn = await duck.getConnection();
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
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

describe('compaction markers', () => {
  it('records every compact_boundary with its metadata', async () => {
    const rows = await compactionsOf(boundaryOnlyFile);
    expect(rows.map((r) => r.uuid)).toEqual(['b-c1', 'b-c2']);
    expect(rows.map((r) => r.trigger)).toEqual(['manual', 'auto']);
    expect(rows[0]?.pre_tokens).toBe(331954);
    expect(rows[0]?.post_tokens).toBe(17672);
    expect(rows.every((r) => r.is_sidechain === false)).toBe(true);
    expect((await sessionRow('boundaryOnly'))?.compaction_count).toBe(2);
  });

  it('counts a boundary and its flagged summary as ONE compaction', async () => {
    const rows = await compactionsOf(join(proj, 'bothMarkers.jsonl'));
    expect(rows.map((r) => r.uuid)).toEqual(['m-c1']); // the boundary wins
    expect((await sessionRow('bothMarkers'))?.compaction_count).toBe(1);
  });

  it('falls back to the flagged summary in a file with no boundary', async () => {
    const rows = await compactionsOf(summaryOnlyFile);
    expect(rows.map((r) => r.uuid)).toEqual(['s-s1']);
    // The 2025 format carries no metadata — unknown, not zero.
    expect(rows[0]?.trigger).toBeNull();
    expect(rows[0]?.pre_tokens).toBeNull();
    expect((await sessionRow('summaryOnly'))?.compaction_count).toBe(1);
  });

  it('records a subagent compaction but keeps it out of the session count', async () => {
    const sub = await compactionsOf(subagentFile);
    expect(sub.map((r) => r.uuid)).toEqual(['w-sc1']);
    expect(sub[0]?.is_sidechain).toBe(true);
    expect(sub[0]?.session_id).toBe('withSub');
    expect((await sessionRow('withSub'))?.compaction_count).toBe(1); // main thread only
  });
});

describe('context at the last turn', () => {
  it('takes the last main-thread prompt size, not the peak or a sidechain', async () => {
    const s = await sessionRow('sawtooth');
    expect(s?.context_tokens).toBe(30000); // not 200000 (peak) and not 999999 (sidechain)
    expect(s?.context_model).toBe(SONNET);
  });

  it('leaves context unknown when no turn billed a prompt', async () => {
    const s = await sessionRow('noUsage');
    expect(s?.context_tokens).toBeNull();
    expect(s?.context_model).toBeNull();
  });
});

describe('incremental reload', () => {
  it('replaces only the reloaded file’s rows (the subagent file survives)', async () => {
    appendFileSync(
      withSubFile,
      jsonl([
        asst({ uuid: 'w-a2', sessionId: 'withSub', ts: '2026-03-04T10:10:00.000Z', messageId: 'w2', prompt: 70000 }),
        boundary({ uuid: 'w-c2', sessionId: 'withSub', ts: '2026-03-04T10:10:01.000Z', trigger: 'auto', pre: 70000, post: 7000 }),
      ]),
    );
    await reindex();

    expect((await compactionsOf(withSubFile)).map((r) => r.uuid)).toEqual(['w-c1', 'w-c2']);
    // Same session id, different file — must not be swept by the parent's reload.
    expect((await compactionsOf(subagentFile)).map((r) => r.uuid)).toEqual(['w-sc1']);
    // Untouched files keep exactly their own rows.
    expect((await compactionsOf(boundaryOnlyFile)).length).toBe(2);
    expect((await sessionRow('withSub'))?.compaction_count).toBe(2);
  });

  it('drops a removed file’s compaction rows', async () => {
    rmSync(summaryOnlyFile);
    await reindex();
    expect(await compactionsOf(summaryOnlyFile)).toEqual([]);
    expect(await sessionRow('summaryOnly')).toBeUndefined();
  });
});

// Runs last: it sees the state the reload tests left behind (withSub has two
// compactions and 70k of context; summaryOnly is gone).
describe('API surface', () => {
  const sessions = async (query = ''): Promise<SessionMeta[]> =>
    (await app.inject({ method: 'GET', url: `/api/sessions${query}` })).json();
  const efficiency = async (query = ''): Promise<SessionEfficiencyResponse> =>
    (await app.inject({ method: 'GET', url: `/api/analytics/sessions${query}` })).json();

  it('maps context/compactions onto session meta, resolving the window through pricing', async () => {
    const byId = new Map((await sessions()).map((s) => [s.id, s]));
    const sawtooth = byId.get('sawtooth')!;
    expect(sawtooth.contextTokens).toBe(30000);
    expect(sawtooth.contextWindow).toBe(200000); // sonnet family knows its window
    expect(sawtooth.compactionCount).toBe(0); // Claude Code records compactions: a real 0
    const boundaryOnly = byId.get('boundaryOnly')!;
    expect(boundaryOnly.contextTokens).toBe(40000);
    expect('contextWindow' in boundaryOnly).toBe(false); // opus family has none
    expect(boundaryOnly.compactionCount).toBe(2);
    // No billed prompt → the key is absent, never 0.
    expect('contextTokens' in byId.get('noUsage')!).toBe(false);
  });

  it('sort=context orders by context size with unknown last', async () => {
    const ids = (await sessions('?sort=context')).map((s) => s.id);
    expect(ids).toEqual(['bothMarkers', 'withSub', 'boundaryOnly', 'sawtooth', 'noUsage']);
  });

  it('exposes both columns in the efficiency table, sortable, with NULL-skipping quantiles', async () => {
    const res = await efficiency('?sort=contextTokens');
    expect(res.rows.map((r) => r.sessionId)).toEqual(['bothMarkers', 'withSub', 'boundaryOnly', 'sawtooth', 'noUsage']);
    const rows = new Map(res.rows.map((r) => [r.sessionId, r]));
    expect(rows.get('sawtooth')).toMatchObject({ contextTokens: 30000, contextWindow: 200000, compactionCount: 0 });
    expect(rows.get('boundaryOnly')).toMatchObject({ contextTokens: 40000, contextWindow: null, compactionCount: 2 });
    expect(rows.get('noUsage')).toMatchObject({ contextTokens: null, contextWindow: null, compactionCount: 0 });
    // Median over the four sessions WITH a context (150k, 70k, 40k, 30k) — the
    // unknown one is skipped, not counted as 0.
    expect(res.summary.columns.contextTokens.median).toBe(55000);
    expect(res.summary.columns.compactionCount.median).toBe(1); // [0, 0, 1, 2, 2]

    const byCompactions = await efficiency('?sort=compactionCount');
    expect(byCompactions.rows.slice(0, 2).map((r) => r.sessionId).sort()).toEqual(['boundaryOnly', 'withSub']);
  });
});
