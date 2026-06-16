/**
 * Cost-deduplication integration tests.
 *
 * Models the two ways Claude Code inflates per-event usage SUMs on disk and
 * verifies the `usage_canonical` election (see `electCanonicalUsage` in
 * `src/data/index.ts`) counts each billed API call exactly once:
 *
 *  1. Multi-block split — one billed API response is written as N JSONL lines,
 *     all sharing `message.id` and repeating the FULL `usage`; earlier lines
 *     may carry a PARTIAL `output_tokens` (streaming progress). The max-output
 *     row is the true one and must be the only one summed.
 *  2. Fork copies — forking a session copies the original's lines into a new
 *     file (sessionId rewritten, uuid/message.id/usage preserved). Marked forks
 *     carry a top-level `forkedFrom`; legacy forks don't. The election prefers
 *     the original over a marked-fork copy, and falls back to a deterministic
 *     `(output_tokens DESC, file_path, uuid)` tiebreak when no marker
 *     distinguishes the rows — so totals stay exact and attribution is stable.
 *
 * Built like `api.integration.test.ts`: a synthetic ~/.claude/projects tree is
 * indexed into a throwaway DuckDB, then exercised through Fastify `.inject()`.
 * The per-token-type breakdown isn't exposed by `/api/sessions` (only
 * totalTokens/cost/messageCount), so the per-session input/output/cache numbers
 * are read straight from the `sessions` table via the DB connection — the same
 * derived table the routes read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DuckDBConnection } from '@duckdb/node-api';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-dedup-'));
const projectsDir = join(work, 'projects');
const dbPath = join(work, 'index.duckdb');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
// Isolate from the real ~/.codex and ~/.junie so this Claude-only suite stays
// deterministic.
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.DUCKDB_PATH = dbPath;
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

// `claude-opus-4-8` has no exact-id row in the default pricing.json, so cost
// resolves via the "opus" family rate (USD per 1M tokens). Mirrored here so the
// expected per-call/per-session cost can be hand-computed.
const MODEL = 'claude-opus-4-8';
const RATE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };
const costOf = (u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number =>
  (u.input * RATE.input + u.output * RATE.output + u.cacheWrite * RATE.cacheWrite + u.cacheRead * RATE.cacheRead) /
  1_000_000;

const CWD = '/tmp/dedup';

/** An assistant line in the canonical Claude transcript shape. */
function asst(opts: {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  messageId?: string; // omitted => NULL message_id (always canonical)
  forkedFrom?: { sessionId: string; messageUuid: string };
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}): Record<string, unknown> {
  const line: Record<string, unknown> = {
    type: 'assistant',
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp,
    cwd: CWD,
    isSidechain: false,
    requestId: `req_${opts.uuid}`,
    message: {
      ...(opts.messageId ? { id: opts.messageId } : {}),
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: `reply ${opts.uuid}` }],
      usage: {
        input_tokens: opts.usage.input,
        output_tokens: opts.usage.output,
        cache_read_input_tokens: opts.usage.cacheRead,
        cache_creation_input_tokens: opts.usage.cacheWrite,
      },
    },
  };
  if (opts.forkedFrom) line.forkedFrom = opts.forkedFrom;
  return line;
}

const user = (uuid: string, parentUuid: string | null, sessionId: string, ts: string, text: string) => ({
  type: 'user',
  uuid,
  parentUuid,
  sessionId,
  timestamp: ts,
  cwd: CWD,
  isSidechain: false,
  message: { role: 'user', content: text },
});

// The four unique billed calls + the NULL-id row, as ground truth for the
// deduped grand totals. (See the per-session breakdown in the asserts.)
const CALLS = {
  // msg_split: written as 3 lines (partial 1, then final 50 x2); max-output wins.
  split: { input: 10, output: 50, cacheRead: 100, cacheWrite: 5 },
  o2: { input: 20, output: 30, cacheRead: 0, cacheWrite: 0 },
  f1: { input: 40, output: 60, cacheRead: 200, cacheWrite: 0 },
  l1: { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 },
  // A NULL-message-id assistant row: always canonical, never deduped away.
  nul: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
} as const;

/**
 * Write the fixture transcripts into one project dir. File names are chosen so
 * the legacy-fork tiebreak (below) is deterministic: 'sessL' < 'sessO'.
 */
function writeFixtures(): void {
  const proj = join(projectsDir, 'enc-dedup');
  mkdirSync(proj, { recursive: true });

  // --- Session O (original) -------------------------------------------------
  // u1 → one API call `msg_split` written as THREE assistant lines (same
  // message.id + full usage; the first carries a PARTIAL output_tokens) → a
  // second normal call `msg_o2` → plus a NULL-message-id assistant row.
  writeFileSync(
    join(proj, 'sessO.jsonl'),
    jsonl([
      { type: 'ai-title', sessionId: 'sessO', aiTitle: 'Session O' },
      user('o-u1', null, 'sessO', '2026-01-01T10:00:00.000Z', 'hello from O'),
      // msg_split line 1: PARTIAL (streaming progress) — same input/cache, output=1.
      asst({ uuid: 'o-a1', parentUuid: 'o-u1', sessionId: 'sessO', timestamp: '2026-01-01T10:00:01.000Z', messageId: 'msg_split', usage: { ...CALLS.split, output: 1 } }),
      // msg_split lines 2 & 3: FINAL — full usage, output=50.
      asst({ uuid: 'o-a2', parentUuid: 'o-u1', sessionId: 'sessO', timestamp: '2026-01-01T10:00:01.300Z', messageId: 'msg_split', usage: CALLS.split }),
      asst({ uuid: 'o-a3', parentUuid: 'o-u1', sessionId: 'sessO', timestamp: '2026-01-01T10:00:01.600Z', messageId: 'msg_split', usage: CALLS.split }),
      // msg_o2: a second, single-line call.
      asst({ uuid: 'o-a4', parentUuid: 'o-a3', sessionId: 'sessO', timestamp: '2026-01-01T10:00:05.000Z', messageId: 'msg_o2', usage: CALLS.o2 }),
      // NULL-message-id assistant row (no message.id) — always canonical.
      asst({ uuid: 'o-a5', parentUuid: 'o-a4', sessionId: 'sessO', timestamp: '2026-01-01T10:00:08.000Z', usage: CALLS.nul }),
    ]),
  );

  // --- Session F (marked fork of O) -----------------------------------------
  // Full copy of O's lines (user + 4 assistant; uuid/message.id/usage preserved,
  // sessionId rewritten), each copied line carrying forkedFrom → these lose the
  // election to O's originals. Then a NEW call `msg_f1` (no forkedFrom).
  const ffrom = { sessionId: 'sessO', messageUuid: 'o-a3' };
  writeFileSync(
    join(proj, 'sessF.jsonl'),
    jsonl([
      { type: 'ai-title', sessionId: 'sessF', aiTitle: 'Session F' },
      { ...user('o-u1', null, 'sessF', '2026-01-01T10:00:00.000Z', 'hello from O'), forkedFrom: ffrom },
      asst({ uuid: 'o-a1', parentUuid: 'o-u1', sessionId: 'sessF', timestamp: '2026-01-01T10:00:01.000Z', messageId: 'msg_split', forkedFrom: ffrom, usage: { ...CALLS.split, output: 1 } }),
      asst({ uuid: 'o-a2', parentUuid: 'o-u1', sessionId: 'sessF', timestamp: '2026-01-01T10:00:01.300Z', messageId: 'msg_split', forkedFrom: ffrom, usage: CALLS.split }),
      asst({ uuid: 'o-a3', parentUuid: 'o-u1', sessionId: 'sessF', timestamp: '2026-01-01T10:00:01.600Z', messageId: 'msg_split', forkedFrom: ffrom, usage: CALLS.split }),
      asst({ uuid: 'o-a4', parentUuid: 'o-a3', sessionId: 'sessF', timestamp: '2026-01-01T10:00:05.000Z', messageId: 'msg_o2', forkedFrom: ffrom, usage: CALLS.o2 }),
      // New turn unique to F.
      user('f-u1', 'o-a4', 'sessF', '2026-01-01T11:00:00.000Z', 'new turn in F'),
      asst({ uuid: 'f-a1', parentUuid: 'f-u1', sessionId: 'sessF', timestamp: '2026-01-01T11:00:05.000Z', messageId: 'msg_f1', usage: CALLS.f1 }),
    ]),
  );

  // --- Session L (legacy fork of O — NO forkedFrom marker) ------------------
  // Just a copy of O's `msg_o2` line (same uuid/message.id/usage, no marker) plus
  // its own new call `msg_l1`.
  writeFileSync(
    join(proj, 'sessL.jsonl'),
    jsonl([
      { type: 'ai-title', sessionId: 'sessL', aiTitle: 'Session L' },
      user('l-u1', null, 'sessL', '2026-01-01T12:00:00.000Z', 'hello from L'),
      // Copy of msg_o2 — same uuid 'o-a4', no forkedFrom (legacy fork).
      asst({ uuid: 'o-a4', parentUuid: 'l-u1', sessionId: 'sessL', timestamp: '2026-01-01T10:00:05.000Z', messageId: 'msg_o2', usage: CALLS.o2 }),
      asst({ uuid: 'l-a1', parentUuid: 'o-a4', sessionId: 'sessL', timestamp: '2026-01-01T12:00:05.000Z', messageId: 'msg_l1', usage: CALLS.l1 }),
    ]),
  );
}

// Sums of the unique billed calls + the NULL-id row = the deduped grand total.
const GRAND = {
  input: CALLS.split.input + CALLS.o2.input + CALLS.f1.input + CALLS.l1.input + CALLS.nul.input,
  output: CALLS.split.output + CALLS.o2.output + CALLS.f1.output + CALLS.l1.output + CALLS.nul.output,
  cacheRead: CALLS.split.cacheRead + CALLS.o2.cacheRead + CALLS.f1.cacheRead + CALLS.l1.cacheRead + CALLS.nul.cacheRead,
  cacheWrite: CALLS.split.cacheWrite + CALLS.o2.cacheWrite + CALLS.f1.cacheWrite + CALLS.l1.cacheWrite + CALLS.nul.cacheWrite,
};
const GRAND_TOTAL_TOKENS = GRAND.input + GRAND.output + GRAND.cacheRead + GRAND.cacheWrite;
const GRAND_COST =
  costOf(CALLS.split) + costOf(CALLS.o2) + costOf(CALLS.f1) + costOf(CALLS.l1) + costOf(CALLS.nul);

let app: FastifyInstance;
let conn: DuckDBConnection;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  writeFixtures();

  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');
  const { getConnection } = await import('../src/db/duckdb.js');
  ({ closeConnection } = await import('../src/db/duckdb.js'));

  app = Fastify();
  await registerRoutes(app);
  await reindex();
  await app.ready();
  conn = await getConnection();
});

afterAll(async () => {
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

const get = async (url: string) => app.inject({ method: 'GET', url });

/** Per-session token columns straight from the derived `sessions` table. */
async function sessionTokens(id: string): Promise<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}> {
  const { queryRows } = await import('../src/db/duckdb.js');
  const rows = await queryRows(
    conn,
    `SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, total_cost_usd
     FROM sessions WHERE id = '${id}'`,
  );
  const r = rows[0]!;
  return {
    input: Number(r.input_tokens),
    output: Number(r.output_tokens),
    cacheRead: Number(r.cache_read_tokens),
    cacheWrite: Number(r.cache_write_tokens),
    total: Number(r.total_tokens),
    cost: Number(r.total_cost_usd),
  };
}

describe('multi-block split + fork dedup — per-session token attribution', () => {
  // Session O keeps the max-output msg_split row (output 50, not the partial 1)
  // and the NULL-id row. It LOSES msg_o2 to session L (see the L tiebreak below).
  // Expected O canonical: msg_split (10/50/100/5) + NULL row (1/2/0/0).
  it('session O: split counted once at max output; NULL-id row always counted', async () => {
    const t = await sessionTokens('sessO');
    expect(t.input).toBe(CALLS.split.input + CALLS.nul.input); // 11
    expect(t.output).toBe(CALLS.split.output + CALLS.nul.output); // 52
    expect(t.cacheRead).toBe(CALLS.split.cacheRead + CALLS.nul.cacheRead); // 100
    expect(t.cacheWrite).toBe(CALLS.split.cacheWrite + CALLS.nul.cacheWrite); // 5
    expect(t.total).toBe(11 + 52 + 100 + 5); // 168
    expect(t.cost).toBeCloseTo(costOf(CALLS.split) + costOf(CALLS.nul), 12);
  });

  // Session F's copied history all carries `forkedFrom`, so every copied row
  // loses its message_id partition to O's (and L's) NULL-forkedFrom rows. Only
  // F's NEW call msg_f1 survives. Expected F canonical: msg_f1 (40/60/200/0).
  it('session F: marked-fork copies lose; only the new call counts', async () => {
    const t = await sessionTokens('sessF');
    expect(t.input).toBe(CALLS.f1.input); // 40
    expect(t.output).toBe(CALLS.f1.output); // 60
    expect(t.cacheRead).toBe(CALLS.f1.cacheRead); // 200
    expect(t.cacheWrite).toBe(CALLS.f1.cacheWrite); // 0
    expect(t.total).toBe(40 + 60 + 200 + 0); // 300
    expect(t.cost).toBeCloseTo(costOf(CALLS.f1), 12);
  });

  // Legacy-fork tiebreak: the msg_o2 partition has O's row and L's copy, both
  // with equal output_tokens, the same uuid, and forked_from_session_id NULL (L
  // has no marker). The election orders by `file_path ASC` next, and
  // 'sessL.jsonl' < 'sessO.jsonl' lexicographically — so L's COPY wins and
  // msg_o2's usage attributes to L, NOT O. (The point of this case is that the
  // totals stay exact and attribution is deterministic, regardless of which
  // file happens to win.) Expected L canonical: msg_o2 (20/30/0/0) + msg_l1 (5/7/0/0).
  it('session L: deterministic file_path tiebreak claims the shared msg_o2', async () => {
    const t = await sessionTokens('sessL');
    expect(t.input).toBe(CALLS.o2.input + CALLS.l1.input); // 25
    expect(t.output).toBe(CALLS.o2.output + CALLS.l1.output); // 37
    expect(t.cacheRead).toBe(CALLS.o2.cacheRead + CALLS.l1.cacheRead); // 0
    expect(t.cacheWrite).toBe(CALLS.o2.cacheWrite + CALLS.l1.cacheWrite); // 0
    expect(t.total).toBe(25 + 37 + 0 + 0); // 62
    expect(t.cost).toBeCloseTo(costOf(CALLS.o2) + costOf(CALLS.l1), 12);
  });

  it('grand total across sessions is invariant: sum == deduped unique calls', async () => {
    const [o, f, l] = await Promise.all([
      sessionTokens('sessO'),
      sessionTokens('sessF'),
      sessionTokens('sessL'),
    ]);
    expect(o.input + f.input + l.input).toBe(GRAND.input); // 76
    expect(o.output + f.output + l.output).toBe(GRAND.output); // 149
    expect(o.cacheRead + f.cacheRead + l.cacheRead).toBe(GRAND.cacheRead); // 300
    expect(o.cacheWrite + f.cacheWrite + l.cacheWrite).toBe(GRAND.cacheWrite); // 5
    expect(o.total + f.total + l.total).toBe(GRAND_TOTAL_TOKENS); // 530
    expect(o.cost + f.cost + l.cost).toBeCloseTo(GRAND_COST, 12);
  });
});

describe('GET /api/sessions — deduped totals surfaced through the API', () => {
  it('per-session totalTokens / totalCostUsd match the deduped values', async () => {
    const sessions = (await get('/api/sessions')).json();
    const byId = new Map(sessions.map((s: { id: string }) => [s.id, s]));

    const o = byId.get('sessO') as { totalTokens: number; totalCostUsd: number };
    const f = byId.get('sessF') as { totalTokens: number; totalCostUsd: number };
    const l = byId.get('sessL') as { totalTokens: number; totalCostUsd: number };

    expect(o.totalTokens).toBe(168);
    expect(f.totalTokens).toBe(300);
    expect(l.totalTokens).toBe(62);

    // Costs are all > 0 and consistent with token attribution (F reflects only
    // msg_f1; F's larger token+cache footprint makes it the costliest here).
    expect(o.totalCostUsd).toBeGreaterThan(0);
    expect(f.totalCostUsd).toBeGreaterThan(0);
    expect(l.totalCostUsd).toBeGreaterThan(0);
    expect(f.totalCostUsd).toBeCloseTo(costOf(CALLS.f1), 12);
    expect(f.totalCostUsd).toBeGreaterThan(o.totalCostUsd);
    expect(f.totalCostUsd).toBeGreaterThan(l.totalCostUsd);

    // Grand total cost equals the sum of the unique-call costs.
    expect(o.totalCostUsd + f.totalCostUsd + l.totalCostUsd).toBeCloseTo(GRAND_COST, 12);
  });

  // message_count is NOT deduped — it counts ALL events (every content-block row
  // and the user turn), proving the dedup only affects the usage/cost SUMs.
  it('message_count still counts every row (not deduped)', async () => {
    const sessions = (await get('/api/sessions')).json();
    const o = sessions.find((s: { id: string }) => s.id === 'sessO');
    // sessO.jsonl carries: u1 + 3 msg_split rows + msg_o2 + NULL-id row = 6
    // user/assistant events. (Far more than the 2 unique billed calls there.)
    expect(o.messageCount).toBe(6);
    expect(o.messageCount).toBeGreaterThanOrEqual(5);
  });
});

describe('GET /api/analytics — deduped grand totals', () => {
  it('totals equal the deduped grand totals', async () => {
    const { totals } = (await get('/api/analytics')).json();
    expect(totals.inputTokens).toBe(GRAND.input); // 76
    expect(totals.outputTokens).toBe(GRAND.output); // 149
    expect(totals.cacheReadTokens).toBe(GRAND.cacheRead); // 300
    expect(totals.cacheCreationTokens).toBe(GRAND.cacheWrite); // 5
    expect(totals.totalTokens).toBe(GRAND_TOTAL_TOKENS); // 530
    expect(totals.costUsd).toBeCloseTo(GRAND_COST, 12);
  });

  it('messageCount equals the unique billed calls + NULL-id assistant rows', async () => {
    const { totals } = (await get('/api/analytics')).json();
    // 4 unique billed calls (msg_split, msg_o2, msg_f1, msg_l1) + 1 NULL-id row.
    expect(totals.messageCount).toBe(5);
  });
});
