/**
 * Session-efficiency endpoint integration tests.
 *
 * Built like dedup.integration.test.ts: a synthetic ~/.claude/projects tree is
 * indexed into a throwaway DuckDB, then exercised through Fastify .inject().
 * Focus on the bug-prone edges: ratio math, the usage_canonical dedup invariant
 * (denominator D counts a billed call once), the minResponses floor, degenerate
 * (no-assistant) exclusion, the started_at date filter, and sort.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionEfficiencyResponse, SessionEfficiencyRow } from '@claudescope/shared';

const work = mkdtempSync(join(tmpdir(), 'claudescope-eff-'));
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

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const CWD = '/tmp/eff';
const MODEL = 'claude-opus-4-8';
const RATE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };
const costOf = (u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number =>
  (u.input * RATE.input + u.output * RATE.output + u.cacheWrite * RATE.cacheWrite + u.cacheRead * RATE.cacheRead) /
  1_000_000;

function asst(opts: {
  uuid: string;
  sessionId: string;
  timestamp: string;
  messageId?: string;
  tools?: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}): Record<string, unknown> {
  const content: unknown[] = [{ type: 'text', text: `reply ${opts.uuid}` }];
  for (let i = 0; i < (opts.tools ?? 0); i++) {
    content.push({ type: 'tool_use', id: `tu_${opts.uuid}_${i}`, name: 'Bash', input: { command: 'ls' } });
  }
  return {
    type: 'assistant',
    uuid: opts.uuid,
    parentUuid: null,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp,
    cwd: CWD,
    isSidechain: false,
    message: {
      ...(opts.messageId ? { id: opts.messageId } : {}),
      role: 'assistant',
      model: MODEL,
      content,
      usage: {
        input_tokens: opts.usage.input,
        output_tokens: opts.usage.output,
        cache_read_input_tokens: opts.usage.cacheRead,
        cache_creation_input_tokens: opts.usage.cacheWrite,
      },
    },
  };
}
const user = (uuid: string, sessionId: string, ts: string, text: string) => ({
  type: 'user', uuid, parentUuid: null, sessionId, timestamp: ts, cwd: CWD,
  isSidechain: false, message: { role: 'user', content: text },
});

function writeFixtures(): void {
  const proj = join(projectsDir, 'eff-proj');
  mkdirSync(proj, { recursive: true });

  // cacheHeavy: 2 clean calls, lots of cache read, no tools. cache-hit ≈ 0.99.
  const ch = { input: 10, output: 20, cacheRead: 1000, cacheWrite: 0 };
  writeFileSync(join(proj, 'cacheHeavy.jsonl'), jsonl([
    { type: 'ai-title', sessionId: 'cacheHeavy', aiTitle: 'Cache heavy' },
    user('h-u1', 'cacheHeavy', '2026-03-01T10:00:00.000Z', 'hi'),
    asst({ uuid: 'h-a1', sessionId: 'cacheHeavy', timestamp: '2026-03-01T10:00:01.000Z', messageId: 'h1', usage: ch }),
    asst({ uuid: 'h-a2', sessionId: 'cacheHeavy', timestamp: '2026-03-01T10:30:00.000Z', messageId: 'h2', usage: ch }),
  ]));

  // cachePoor: 3 calls, no cache, 2 tools each. cache-hit = 0, tools/resp = 2.
  const cp = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
  writeFileSync(join(proj, 'cachePoor.jsonl'), jsonl([
    { type: 'ai-title', sessionId: 'cachePoor', aiTitle: 'Cache poor' },
    user('p-u1', 'cachePoor', '2026-03-02T10:00:00.000Z', 'hi'),
    asst({ uuid: 'p-a1', sessionId: 'cachePoor', timestamp: '2026-03-02T10:00:01.000Z', messageId: 'p1', tools: 2, usage: cp }),
    asst({ uuid: 'p-a2', sessionId: 'cachePoor', timestamp: '2026-03-02T10:00:02.000Z', messageId: 'p2', tools: 2, usage: cp }),
    asst({ uuid: 'p-a3', sessionId: 'cachePoor', timestamp: '2026-03-02T10:00:03.000Z', messageId: 'p3', tools: 2, usage: cp }),
  ]));

  // splitDedup: one billed call written as 3 lines (same id) + one normal call.
  // Canonical responses must be 2, not 4; cost counts the split once.
  const sp = { input: 10, output: 30, cacheRead: 500, cacheWrite: 0 };
  const sp2 = { input: 10, output: 10, cacheRead: 500, cacheWrite: 0 };
  writeFileSync(join(proj, 'splitDedup.jsonl'), jsonl([
    { type: 'ai-title', sessionId: 'splitDedup', aiTitle: 'Split dedup' },
    user('s-u1', 'splitDedup', '2026-03-03T10:00:00.000Z', 'hi'),
    asst({ uuid: 's-a1', sessionId: 'splitDedup', timestamp: '2026-03-03T10:00:01.000Z', messageId: 'msg_s', usage: { ...sp, output: 1 } }),
    asst({ uuid: 's-a2', sessionId: 'splitDedup', timestamp: '2026-03-03T10:00:01.300Z', messageId: 'msg_s', usage: sp }),
    asst({ uuid: 's-a3', sessionId: 'splitDedup', timestamp: '2026-03-03T10:00:01.600Z', messageId: 'msg_s', usage: sp }),
    asst({ uuid: 's-a4', sessionId: 'splitDedup', timestamp: '2026-03-03T10:00:05.000Z', messageId: 'msg_s2', usage: sp2 }),
  ]));

  // oneShot: a single assistant response — below a minResponses=2 floor.
  writeFileSync(join(proj, 'oneShot.jsonl'), jsonl([
    { type: 'ai-title', sessionId: 'oneShot', aiTitle: 'One shot' },
    user('o-u1', 'oneShot', '2026-03-04T10:00:00.000Z', 'hi'),
    asst({ uuid: 'o-a1', sessionId: 'oneShot', timestamp: '2026-03-04T10:00:01.000Z', messageId: 'o1', usage: cp }),
  ]));

  // noAssistant: only user events — D = 0, must never appear.
  writeFileSync(join(proj, 'noAssistant.jsonl'), jsonl([
    { type: 'ai-title', sessionId: 'noAssistant', aiTitle: 'No assistant' },
    user('n-u1', 'noAssistant', '2026-03-05T10:00:00.000Z', 'hi'),
    user('n-u2', 'noAssistant', '2026-03-05T10:00:02.000Z', 'still hi'),
  ]));

  // oldStamp: cache-heavy clone started in 2025 — excluded by from=2026-01-01.
  writeFileSync(join(proj, 'oldStamp.jsonl'), jsonl([
    { type: 'ai-title', sessionId: 'oldStamp', aiTitle: 'Old' },
    user('d-u1', 'oldStamp', '2025-06-01T10:00:00.000Z', 'hi'),
    asst({ uuid: 'd-a1', sessionId: 'oldStamp', timestamp: '2025-06-01T10:00:01.000Z', messageId: 'd1', usage: ch }),
    asst({ uuid: 'd-a2', sessionId: 'oldStamp', timestamp: '2025-06-01T10:00:02.000Z', messageId: 'd2', usage: ch }),
  ]));
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  writeFixtures();
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');
  ({ closeConnection } = await import('../src/db/duckdb.js'));
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

const fetchEff = async (query = ''): Promise<SessionEfficiencyResponse> =>
  (await app.inject({ method: 'GET', url: `/api/analytics/sessions${query}` })).json();
const byId = (r: SessionEfficiencyResponse) =>
  new Map(r.rows.map((row) => [row.sessionId, row]));

describe('GET /api/analytics/sessions', () => {
  it('computes the four ratios per session', async () => {
    const res = await fetchEff('?minResponses=1');
    const m = byId(res);

    const ch = m.get('cacheHeavy') as SessionEfficiencyRow;
    expect(ch.responses).toBe(2);
    expect(ch.cacheHitRatio).toBeCloseTo(2000 / (2000 + 0 + 20), 6);
    expect(ch.toolCallsPerResponse).toBe(0);
    expect(ch.costPerResponse).toBeCloseTo((costOf({ input: 10, output: 20, cacheRead: 1000, cacheWrite: 0 }) * 2) / 2, 12);
    expect(ch.tokensPerResponse).toBe((20 + 40 + 2000 + 0) / 2); // 1030

    const cp = m.get('cachePoor') as SessionEfficiencyRow;
    expect(cp.responses).toBe(3);
    expect(cp.cacheHitRatio).toBe(0);
    expect(cp.toolCallsPerResponse).toBe(2);
    expect(cp.tokensPerResponse).toBe((3000 + 300) / 3); // 1100
  });

  it('counts a multi-block split as ONE response (usage_canonical dedup)', async () => {
    const m = byId(await fetchEff('?minResponses=1'));
    const s = m.get('splitDedup') as SessionEfficiencyRow;
    expect(s.responses).toBe(2); // msg_s once + msg_s2 — not 4
    expect(s.costUsd).toBeCloseTo(
      costOf({ input: 10, output: 30, cacheRead: 500, cacheWrite: 0 }) +
        costOf({ input: 10, output: 10, cacheRead: 500, cacheWrite: 0 }),
      12,
    );
  });

  it('excludes degenerate (no-assistant) sessions even at minResponses=1', async () => {
    const m = byId(await fetchEff('?minResponses=1'));
    expect(m.has('noAssistant')).toBe(false);
  });

  it('applies the minResponses floor to rows and median', async () => {
    const all = await fetchEff('?minResponses=1');
    expect(byId(all).has('oneShot')).toBe(true);
    const floored = await fetchEff('?minResponses=2');
    expect(byId(floored).has('oneShot')).toBe(false);
    expect(floored.summary.sessionCount).toBe(byId(floored).size);
  });

  it('filters by project slug (shared scope resolution; bogus slug matches nothing)', async () => {
    // Dynamic import, matching the file's env-before-server-modules pattern.
    const { projectIdFromCwd } = await import('../src/data/project-id.js');
    const slug = projectIdFromCwd(CWD);
    const scoped = await fetchEff(`?minResponses=1&project=${encodeURIComponent(slug)}`);
    const all = await fetchEff('?minResponses=1');
    expect(scoped.rows.length).toBe(all.rows.length);
    const none = await fetchEff('?minResponses=1&project=no-such-project');
    expect(none.rows.length).toBe(0);
  });

  it('filters by session start (from)', async () => {
    const m = byId(await fetchEff('?minResponses=1&from=2026-01-01T00:00:00.000Z'));
    expect(m.has('oldStamp')).toBe(false);
    expect(m.has('cacheHeavy')).toBe(true);
  });

  it('sorts by the requested column (cacheHitRatio desc)', async () => {
    const res = await fetchEff('?minResponses=1&sort=cacheHitRatio');
    const idx = res.rows.findIndex((r) => r.sessionId === 'cachePoor');
    // cachePoor has cache-hit 0 → must rank below the cache-heavy sessions.
    expect(res.rows[0].cacheHitRatio).toBeGreaterThan(0);
    expect(idx).toBeGreaterThan(0);
  });

  it('returns no NaN/Infinity in any numeric field', async () => {
    const res = await fetchEff('?minResponses=1');
    for (const row of res.rows) {
      for (const v of Object.values(row)) {
        if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('computes summary over the full filtered set, independent of limit (Top-N page)', async () => {
    const page1 = await fetchEff('?minResponses=1&limit=1');
    const full = await fetchEff('?minResponses=1&limit=50');
    expect(page1.rows.length).toBe(1);
    expect(full.rows.length).toBeGreaterThan(1);
    // sessionCount + per-column stats reflect ALL qualifying sessions, not the page.
    expect(page1.summary.sessionCount).toBe(full.summary.sessionCount);
    expect(page1.summary.totalCostUsd).toBeCloseTo(full.summary.totalCostUsd, 12);
    expect(page1.summary.columns.cacheHitRatio.median).toBeCloseTo(
      full.summary.columns.cacheHitRatio.median,
      12,
    );
    expect(page1.summary.columns.costPerResponse.median).toBeCloseTo(
      full.summary.columns.costPerResponse.median,
      12,
    );
  });

  it('returns per-column quartiles (q1 ≤ median ≤ q3) for the IQR fences', async () => {
    const { summary } = await fetchEff('?minResponses=1');
    for (const col of ['cacheHitRatio', 'costPerResponse', 'toolCallsPerResponse'] as const) {
      const s = summary.columns[col];
      expect(s.q1).toBeLessThanOrEqual(s.median);
      expect(s.median).toBeLessThanOrEqual(s.q3);
      expect(Number.isFinite(s.q1)).toBe(true);
      expect(Number.isFinite(s.q3)).toBe(true);
    }
    // top3 cost concentration is a subset of total spend.
    expect(summary.top3CostUsd).toBeGreaterThan(0);
    expect(summary.top3CostUsd).toBeLessThanOrEqual(summary.totalCostUsd + 1e-9);
  });

  it('honors sort direction (asc is the reverse of desc)', async () => {
    const desc = await fetchEff('?minResponses=1&sort=cost&dir=desc');
    const asc = await fetchEff('?minResponses=1&sort=cost&dir=asc');
    for (let i = 1; i < desc.rows.length; i++) {
      expect(desc.rows[i].costUsd).toBeLessThanOrEqual(desc.rows[i - 1].costUsd);
    }
    for (let i = 1; i < asc.rows.length; i++) {
      expect(asc.rows[i].costUsd).toBeGreaterThanOrEqual(asc.rows[i - 1].costUsd);
    }
    // cheapest session leads asc; priciest leads desc.
    expect(asc.rows[0].costUsd).toBeLessThanOrEqual(desc.rows[0].costUsd);
  });
});
