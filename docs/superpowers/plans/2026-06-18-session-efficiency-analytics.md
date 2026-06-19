# Session-efficiency Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Session efficiency" view to the Analytics page — a sortable, date-range-aware Top-N table of sessions showing four per-session efficiency ratios against a median baseline.

**Architecture:** A new read-only endpoint `GET /api/analytics/sessions` runs the existing analytics aggregation (assistant events, `usage_canonical` dedup, the shared cache-hit denominator) but `GROUP BY session_id`, joined to the derived `sessions` table for identity. It returns the Top-N rows by a chosen sort plus a median summary computed over the full filtered set. The web Analytics page gains an `Overview | Session efficiency` view switch; the new view renders a presentational table component. All ratio math lives server-side (so it is covered by the server integration test); the web piece is presentational.

**Tech Stack:** TypeScript (ESM), Fastify, DuckDB (`@duckdb/node-api`), React + Vite, Vitest. Design spec: `docs/plans/0027-session-efficiency-analytics.md`.

## Global Constraints

- **ESM with explicit `.js` import extensions** — e.g. `import { toIso } from './projects.js'` even though the source is `.ts`. Copy the style of neighboring files verbatim.
- **Read-only sources** — never write to any agent home dir; this feature only reads the already-built DuckDB index.
- **Denominator `D` = deduped assistant responses** — `count(*) FILTER (WHERE usage_canonical)` over `type='assistant'` rows. Same "message" semantics as `routes/analytics.ts`.
- **Cache-hit = `cache_read / (cache_read + cache_write + input)`** — the 3-term denominator already used in `routes/analytics.ts`.
- **`minResponses` default 1, clamped to ≥1** — guarantees every returned row has `D ≥ 1`, so per-response ratio fields are always plain numbers.
- **Date filter on `started_at`** (session start), not per-event `ts`.
- **Never interpolate the raw `sort` param into SQL** — map it through a whitelist; default to `cost`.
- **Conventional Commits** (`feat:`, `test:`, …); **no AI co-author / "Generated with" trailers.**
- **Linear history** — do this work on a branch `feat/session-efficiency-analytics`; integrate via PR (rebase/squash), not a push to `main`.
- After every task: `npm run typecheck && npm test` must be green.

---

### Task 0: Branch

- [ ] **Step 1: Create the feature branch**

Run:
```bash
git checkout main && git pull --ff-only
git checkout -b feat/session-efficiency-analytics
```

---

### Task 1: Shared API contract

**Files:**
- Modify: `packages/shared/src/api.ts` (append after the existing `AnalyticsQuery` block, ~line 147)

**Interfaces:**
- Produces: `SessionEfficiencySort`, `SessionEfficiencyQuery`, `SessionEfficiencyRow`, `SessionEfficiencyResponse` — consumed by Task 2 (server) and Task 3 (web).

- [ ] **Step 1: Add the contract types**

Append to `packages/shared/src/api.ts`:

```ts
// ---------------------------------------------------------------------------
// Session efficiency (per-session ratios)
// ---------------------------------------------------------------------------

/** Sortable columns for the session-efficiency table. All sort descending. */
export type SessionEfficiencySort =
  | 'cost'
  | 'tokens'
  | 'responses'
  | 'duration'
  | 'cacheHitRatio'
  | 'costPerResponse'
  | 'tokensPerResponse'
  | 'toolCallsPerResponse';

export interface SessionEfficiencyQuery {
  /** Inclusive ISO lower bound on session START. */
  from?: string;
  /** Inclusive ISO upper bound on session START. */
  to?: string;
  /** Sort column (default 'cost'). */
  sort?: SessionEfficiencySort;
  /** Max rows returned (default 50). */
  limit?: number;
  /** Minimum deduped assistant responses for a session to qualify (default 1, clamped ≥1). */
  minResponses?: number;
}

/** One session's efficiency row. Per-response ratios are always defined (D ≥ 1). */
export interface SessionEfficiencyRow {
  sessionId: string;
  title: string;
  titleDerived: boolean;
  projectId: string;
  projectDisplayName: string;
  connectorId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** D — deduped assistant responses. */
  responses: number;
  totalTokens: number;
  costUsd: number;
  toolCallCount: number;
  /** cache_read / (cache_read + cache_write + input), in [0, 1]. */
  cacheHitRatio: number;
  costPerResponse: number;
  tokensPerResponse: number;
  toolCallsPerResponse: number;
}

/** GET /api/analytics/sessions */
export interface SessionEfficiencyResponse {
  /** Top-N rows by the requested sort. */
  rows: SessionEfficiencyRow[];
  summary: {
    /** Qualifying sessions (post minResponses + date filter). */
    sessionCount: number;
    /** Medians across the full filtered set (not just the returned rows). */
    median: {
      cacheHitRatio: number;
      costPerResponse: number;
      tokensPerResponse: number;
      toolCallsPerResponse: number;
    };
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/api.ts
git commit -m "feat(shared): add session-efficiency API contract"
```

---

### Task 2: Server endpoint `GET /api/analytics/sessions`

**Files:**
- Create: `packages/server/src/routes/analytics-sessions.ts`
- Modify: `packages/server/src/routes/index.ts` (import + register)
- Test: `packages/server/test/session-efficiency.integration.test.ts`

**Interfaces:**
- Consumes: `SessionEfficiencyResponse`, `SessionEfficiencyRow`, `SessionEfficiencySort` (Task 1); `getConnection`, `queryRows`, `sqlString` from `../db/duckdb.js`; `readRow` from `../db/row.js`; `projectIdFromCwd`, `displayNameFromCwd` from `../data/project-id.js`; `toIso` from `./projects.js`.
- Produces: `registerSessionEfficiencyRoute(app)` — registered in `routes/index.ts`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/server/test/session-efficiency.integration.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w packages/server -- session-efficiency`
Expected: FAIL — the route is unregistered, so `/api/analytics/sessions` 404s and `.json()` yields no `rows`.

- [ ] **Step 3: Create the route**

Create `packages/server/src/routes/analytics-sessions.ts`:

```ts
/**
 * GET /api/analytics/sessions — per-session efficiency ratios.
 *
 * Same aggregation semantics as /api/analytics (assistant events,
 * usage_canonical dedup, the shared cache-hit denominator) but GROUP BY
 * session_id, joined to the derived `sessions` table for identity. Returns the
 * Top-N rows by the chosen sort plus a median summary over the FULL filtered set.
 *
 * Date bounds filter on the session START — a session is atomic here, so
 * per-event windowing would half-count a session straddling the boundary. The
 * minResponses floor (clamped ≥1) guarantees every returned row has D ≥ 1, so the
 * per-response ratios are always finite numbers.
 */
import type { FastifyInstance } from 'fastify';
import type {
  SessionEfficiencyResponse,
  SessionEfficiencyRow,
  SessionEfficiencySort,
} from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { projectIdFromCwd, displayNameFromCwd } from '../data/project-id.js';
import { toIso } from './projects.js';

// Whitelist: sort key -> ORDER BY column. Never interpolate the raw param.
const SORT_EXPR: Record<SessionEfficiencySort, string> = {
  cost: 'cost_usd',
  tokens: 'total_tokens',
  responses: 'responses',
  duration: 'duration_ms',
  cacheHitRatio: 'cache_hit_ratio',
  costPerResponse: 'cost_per_response',
  tokensPerResponse: 'tokens_per_response',
  toolCallsPerResponse: 'tool_calls_per_response',
};

function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  const n = raw === undefined ? dflt : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export async function registerSessionEfficiencyRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { from?: string; to?: string; sort?: string; limit?: string; minResponses?: string };
  }>('/api/analytics/sessions', async (req): Promise<SessionEfficiencyResponse> => {
    const conn = await getConnection();

    const sort: SessionEfficiencySort =
      req.query.sort && req.query.sort in SORT_EXPR
        ? (req.query.sort as SessionEfficiencySort)
        : 'cost';
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const minResponses = clampInt(req.query.minResponses, 1, 1, 1_000_000);
    const fromClause = req.query.from ? `AND s.started_at >= ${sqlString(req.query.from)}::TIMESTAMP` : '';
    const toClause = req.query.to ? `AND s.started_at <= ${sqlString(req.query.to)}::TIMESTAMP` : '';

    // Shared CTE: per-session deduped sums -> derived ratios, filtered.
    const cte = `
      WITH agg AS (
        SELECT
          e.session_id AS session_id,
          sum(e.input_tokens)       FILTER (WHERE e.usage_canonical) AS input_tokens,
          sum(e.output_tokens)      FILTER (WHERE e.usage_canonical) AS output_tokens,
          sum(e.cache_write_tokens) FILTER (WHERE e.usage_canonical) AS cache_write_tokens,
          sum(e.cache_read_tokens)  FILTER (WHERE e.usage_canonical) AS cache_read_tokens,
          sum(e.cost_usd)           FILTER (WHERE e.usage_canonical) AS cost_usd,
          sum(e.tool_use_count)     FILTER (WHERE e.usage_canonical) AS tool_call_count,
          count(*)                  FILTER (WHERE e.usage_canonical) AS responses
        FROM events e
        WHERE e.type = 'assistant'
        GROUP BY e.session_id
      ),
      derived AS (
        SELECT
          a.session_id,
          s.title, s.title_derived, s.project_cwd, s.connector_id,
          s.started_at, s.ended_at,
          COALESCE(a.input_tokens, 0)       AS input_tokens,
          COALESCE(a.output_tokens, 0)      AS output_tokens,
          COALESCE(a.cache_write_tokens, 0) AS cache_write_tokens,
          COALESCE(a.cache_read_tokens, 0)  AS cache_read_tokens,
          COALESCE(a.cost_usd, 0)           AS cost_usd,
          COALESCE(a.tool_call_count, 0)    AS tool_call_count,
          a.responses                       AS responses,
          (COALESCE(a.input_tokens,0) + COALESCE(a.output_tokens,0)
            + COALESCE(a.cache_write_tokens,0) + COALESCE(a.cache_read_tokens,0)) AS total_tokens,
          CASE
            WHEN (COALESCE(a.cache_read_tokens,0) + COALESCE(a.cache_write_tokens,0) + COALESCE(a.input_tokens,0)) > 0
            THEN COALESCE(a.cache_read_tokens,0)::DOUBLE
                 / (COALESCE(a.cache_read_tokens,0) + COALESCE(a.cache_write_tokens,0) + COALESCE(a.input_tokens,0))
            ELSE 0
          END AS cache_hit_ratio,
          COALESCE(a.cost_usd,0)::DOUBLE / NULLIF(a.responses, 0) AS cost_per_response,
          (COALESCE(a.input_tokens,0) + COALESCE(a.output_tokens,0)
            + COALESCE(a.cache_write_tokens,0) + COALESCE(a.cache_read_tokens,0))::DOUBLE
            / NULLIF(a.responses, 0) AS tokens_per_response,
          COALESCE(a.tool_call_count,0)::DOUBLE / NULLIF(a.responses, 0) AS tool_calls_per_response,
          CASE
            WHEN s.ended_at IS NOT NULL AND s.started_at IS NOT NULL
            THEN epoch_ms(s.ended_at) - epoch_ms(s.started_at)
            ELSE 0
          END AS duration_ms
        FROM agg a
        JOIN sessions s ON s.id = a.session_id
        WHERE a.responses >= ${minResponses}
          ${fromClause}
          ${toClause}
      )
    `;

    const rowsRaw = await queryRows(
      conn,
      `${cte}
       SELECT * FROM derived
       ORDER BY ${SORT_EXPR[sort]} DESC NULLS LAST, started_at DESC NULLS LAST, session_id
       LIMIT ${limit}`,
    );

    const rows: SessionEfficiencyRow[] = rowsRaw.map((r) => {
      const rd = readRow(r, 'session-efficiency');
      const cwd = rd.str('project_cwd');
      return {
        sessionId: rd.str('session_id'),
        title: rd.str('title'),
        titleDerived: rd.bool('title_derived'),
        projectId: cwd ? projectIdFromCwd(cwd) : 'unknown',
        projectDisplayName: cwd ? displayNameFromCwd(cwd) : 'unknown',
        connectorId: rd.str('connector_id', 'unknown'),
        startedAt: toIso(rd.req('started_at')),
        endedAt: toIso(rd.req('ended_at')),
        durationMs: rd.num('duration_ms'),
        responses: rd.num('responses'),
        totalTokens: rd.num('total_tokens'),
        costUsd: rd.num('cost_usd'),
        toolCallCount: rd.num('tool_call_count'),
        cacheHitRatio: rd.num('cache_hit_ratio'),
        costPerResponse: rd.num('cost_per_response'),
        tokensPerResponse: rd.num('tokens_per_response'),
        toolCallsPerResponse: rd.num('tool_calls_per_response'),
      };
    });

    const summaryRows = await queryRows(
      conn,
      `${cte}
       SELECT
         count(*)                       AS session_count,
         median(cache_hit_ratio)        AS m_cache,
         median(cost_per_response)      AS m_cost,
         median(tokens_per_response)    AS m_tokens,
         median(tool_calls_per_response) AS m_tools
       FROM derived`,
    );
    const sr = readRow(summaryRows[0] ?? {}, 'session-efficiency-summary');

    return {
      rows,
      summary: {
        sessionCount: sr.num('session_count'),
        median: {
          cacheHitRatio: sr.num('m_cache'),
          costPerResponse: sr.num('m_cost'),
          tokensPerResponse: sr.num('m_tokens'),
          toolCallsPerResponse: sr.num('m_tools'),
        },
      },
    };
  });
}
```

- [ ] **Step 4: Register the route**

In `packages/server/src/routes/index.ts`, add the import next to the others:

```ts
import { registerSessionEfficiencyRoute } from './analytics-sessions.js';
```

and call it right after `registerAnalyticsRoute(app)`:

```ts
  await registerAnalyticsRoute(app);
  await registerSessionEfficiencyRoute(app);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w packages/server -- session-efficiency`
Expected: PASS (all cases green).

- [ ] **Step 6: Full check + commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

```bash
git add packages/server/src/routes/analytics-sessions.ts packages/server/src/routes/index.ts packages/server/test/session-efficiency.integration.test.ts
git commit -m "feat(server): add GET /api/analytics/sessions efficiency endpoint"
```

---

### Task 3: Web — client method, formatters, view switch, and table

**Files:**
- Modify: `packages/web/src/api/client.ts` (params interface + `sessionEfficiency` method + type imports)
- Modify: `packages/web/src/pages/analytics/format.ts` (add `formatDuration`, `formatPerCost`)
- Create: `packages/web/src/pages/analytics/SessionEfficiencyTable.tsx`
- Modify: `packages/web/src/pages/analytics/AnalyticsPage.tsx` (view switch + fetch + render)
- Modify: `packages/web/src/pages/analytics/analytics.css` (table styles)

**Interfaces:**
- Consumes: `SessionEfficiencyResponse`, `SessionEfficiencyRow`, `SessionEfficiencySort` (Task 1); `api.sessionEfficiency` (this task); `formatCount`, `formatCost`, `formatPct` (existing `format.ts`); `Link` from `react-router-dom`; `agentLabel` from `../../components/index.js`.
- Produces: the `Session efficiency` view on `/analytics`.

> **Note on tests:** all ratio math is server-side and covered by Task 2. This task is presentational; the repo's web tests cover pure functions only (no React-render harness), so verification here is `typecheck` + `build` + a manual app check. The two new pure formatters are simple enough not to warrant their own tests (per repo convention).

- [ ] **Step 1: Add the client method**

In `packages/web/src/api/client.ts`, extend the type import block with:

```ts
  SessionEfficiencyResponse,
  SessionEfficiencySort,
```

Add the params interface after `AnalyticsParams`:

```ts
export interface SessionEfficiencyParams {
  from?: string;
  to?: string;
  sort?: SessionEfficiencySort;
  limit?: number;
  minResponses?: number;
}
```

Add the method inside the `api` object, right after `analytics(...)`:

```ts
  /** GET /api/analytics/sessions?from=&to=&sort=&limit=&minResponses= */
  sessionEfficiency(
    params: SessionEfficiencyParams = {},
    signal?: AbortSignal,
  ): Promise<SessionEfficiencyResponse> {
    return request<SessionEfficiencyResponse>(
      `/analytics/sessions${qs({
        from: params.from,
        to: params.to,
        sort: params.sort,
        limit: params.limit,
        minResponses: params.minResponses,
      })}`,
      { signal },
    );
  },
```

- [ ] **Step 2: Add the two formatters**

Append to `packages/web/src/pages/analytics/format.ts`:

```ts
/** Compact wall-clock duration: 0 → "—", else "2h 10m" / "5m" / "30s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Per-response cost: keep sub-cent precision (e.g. $0.0011) where formatCost rounds away. */
export function formatPerCost(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 0.01) return formatCost(n);
  return `$${n.toFixed(4)}`;
}
```

- [ ] **Step 3: Create the table component**

Create `packages/web/src/pages/analytics/SessionEfficiencyTable.tsx`:

```tsx
/**
 * Session-efficiency table: per-session ratios with a median footer row. Sorting
 * is server-driven (Top-N is computed server-side), so a header click calls
 * onSortChange and the page re-queries. Rows deep-link to the session.
 */
import { Link } from 'react-router-dom';
import type { SessionEfficiencyResponse, SessionEfficiencySort } from '@claudescope/shared';
import { agentLabel } from '../../components/index.js';
import { formatCount, formatCost, formatPct, formatDuration, formatPerCost } from './format.js';

interface Column {
  key: SessionEfficiencySort;
  label: string;
  render: (r: SessionEfficiencyResponse['rows'][number]) => string;
  median?: (m: SessionEfficiencyResponse['summary']['median']) => string;
}

const COLUMNS: Column[] = [
  { key: 'responses', label: 'Resp', render: (r) => String(r.responses) },
  { key: 'cost', label: 'Cost', render: (r) => formatCost(r.costUsd) },
  { key: 'tokens', label: 'Tokens', render: (r) => formatCount(r.totalTokens) },
  { key: 'duration', label: 'Dur', render: (r) => formatDuration(r.durationMs) },
  { key: 'cacheHitRatio', label: 'Cache', render: (r) => formatPct(r.cacheHitRatio), median: (m) => formatPct(m.cacheHitRatio) },
  { key: 'costPerResponse', label: '$/resp', render: (r) => formatPerCost(r.costPerResponse), median: (m) => formatPerCost(m.costPerResponse) },
  { key: 'tokensPerResponse', label: 'Tok/resp', render: (r) => formatCount(r.tokensPerResponse), median: (m) => formatCount(m.tokensPerResponse) },
  { key: 'toolCallsPerResponse', label: 'Tools/resp', render: (r) => r.toolCallsPerResponse.toFixed(2), median: (m) => m.toolCallsPerResponse.toFixed(2) },
];

export function SessionEfficiencyTable({
  data,
  sort,
  onSortChange,
}: {
  data: SessionEfficiencyResponse;
  sort: SessionEfficiencySort;
  onSortChange: (s: SessionEfficiencySort) => void;
}) {
  return (
    <table className="tv-eff-table">
      <thead>
        <tr>
          <th className="tv-eff-table__session">Session</th>
          {COLUMNS.map((c) => (
            <th key={c.key}>
              <button
                type="button"
                className={sort === c.key ? 'tv-eff-table__sort is-active' : 'tv-eff-table__sort'}
                aria-pressed={sort === c.key}
                onClick={() => onSortChange(c.key)}
              >
                {c.label}
                {sort === c.key && <span aria-hidden="true"> ↓</span>}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r) => (
          <tr key={r.sessionId}>
            <td className="tv-eff-table__session">
              <Link to={`/sessions/${r.sessionId}`} className="tv-eff-table__link">
                <span className="tv-eff-table__title">{r.title || '(untitled)'}</span>
                <span className="tv-eff-table__meta">
                  {r.projectDisplayName} · {agentLabel(r.connectorId)}
                </span>
              </Link>
            </td>
            {COLUMNS.map((c) => (
              <td key={c.key}>{c.render(r)}</td>
            ))}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="tv-eff-table__median">
          <td className="tv-eff-table__session">median · {data.summary.sessionCount} sessions</td>
          {COLUMNS.map((c) => (
            <td key={c.key}>{c.median ? c.median(data.summary.median) : '—'}</td>
          ))}
        </tr>
      </tfoot>
    </table>
  );
}
```

- [ ] **Step 4: Wire the view switch into the page**

In `packages/web/src/pages/analytics/AnalyticsPage.tsx`:

(a) Extend imports:

```ts
import type {
  AnalyticsGroupBy,
  AnalyticsResponse,
  AnalyticsTotals,
  ProjectMeta,
  SessionEfficiencyResponse,
  SessionEfficiencySort,
} from '@claudescope/shared';
```

and add:

```ts
import { SessionEfficiencyTable } from './SessionEfficiencyTable.js';
```

(b) Add state inside `AnalyticsPage`, after the `showCache` line:

```ts
  const [view, setView] = useState<'overview' | 'sessions'>('overview');
  const [effSort, setEffSort] = useState<SessionEfficiencySort>('cost');
  const [minResponses, setMinResponses] = useState(1);
  const [eff, setEff] = useState<{
    data: SessionEfficiencyResponse | null;
    loading: boolean;
    error: unknown;
  }>({ data: null, loading: true, error: null });
```

(c) Add a fetch effect after the existing `useEffect(() => load(), [load])`:

```ts
  useEffect(() => {
    if (view !== 'sessions') return;
    const ctrl = new AbortController();
    setEff((s) => ({ ...s, loading: true, error: null }));
    api
      .sessionEfficiency(
        { from: range.from, to: range.to, sort: effSort, minResponses, limit: 50 },
        ctrl.signal,
      )
      .then((data) => setEff({ data, loading: false, error: null }))
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        setEff({ data: null, loading: false, error });
      });
    return () => ctrl.abort();
  }, [view, range.from, range.to, effSort, minResponses]);
```

(d) Add a view-switch control as the FIRST child of the `tv-analytics__toolbar` div (before the "Group by" field):

```tsx
        <div className="tv-analytics__field">
          <span className="tv-analytics__field-label">View</span>
          <div className="tv-segmented" role="group" aria-label="View">
            <button
              type="button"
              className={view === 'overview' ? 'tv-segmented__btn is-active' : 'tv-segmented__btn'}
              aria-pressed={view === 'overview'}
              onClick={() => setView('overview')}
            >
              Overview
            </button>
            <button
              type="button"
              className={view === 'sessions' ? 'tv-segmented__btn is-active' : 'tv-segmented__btn'}
              aria-pressed={view === 'sessions'}
              onClick={() => setView('sessions')}
            >
              Session efficiency
            </button>
          </div>
        </div>
```

(e) Wrap the existing `Group by` field so it only shows in overview — change the opening of that field from `<div className="tv-analytics__field">` (the Group by one) to:

```tsx
        {view === 'overview' && (
          <div className="tv-analytics__field">
            {/* ...existing Group by segmented control unchanged... */}
          </div>
        )}
```

(f) Add a min-responses control that only shows in the sessions view, right after the "Show cache" toggle:

```tsx
        {view === 'sessions' && (
          <div className="tv-analytics__field">
            <label className="tv-analytics__field-label" htmlFor="tv-minresp">
              Min responses
            </label>
            <input
              id="tv-minresp"
              type="number"
              min={1}
              className="tv-analytics__date"
              value={minResponses}
              onChange={(e) => setMinResponses(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
        )}
```

(g) Replace the body `{error ? (...) : (<> ...charts... </>)}` so the sessions view renders the table. Change the success branch to switch on `view`:

```tsx
      {view === 'sessions' ? (
        eff.error ? (
          <ErrorBox error={eff.error} title="Failed to load session efficiency" onRetry={() => setView('sessions')} />
        ) : (
          <section className="tv-card tv-chart-card">
            <div className="tv-chart-card__head">
              <div className="tv-chart-card__heading">
                <h2 className="tv-chart-card__title">Session efficiency</h2>
                <span className="tv-chart-card__hint">top 50 · ratios vs. median</span>
              </div>
            </div>
            {eff.loading ? (
              <div className="tv-chart-empty">
                <Spinner label="Loading…" />
              </div>
            ) : !eff.data || eff.data.rows.length === 0 ? (
              <div className="tv-chart-empty">No sessions with ≥{minResponses} responses in range.</div>
            ) : (
              <div className="tv-eff-table__scroll">
                <SessionEfficiencyTable data={eff.data} sort={effSort} onSortChange={setEffSort} />
              </div>
            )}
          </section>
        )
      ) : error ? (
        <ErrorBox error={error} title="Failed to load analytics" onRetry={load} />
      ) : (
        <>
          {/* ...existing SummaryCards + tv-analytics__charts block, unchanged... */}
        </>
      )}
```

- [ ] **Step 5: Add table styles**

Append to `packages/web/src/pages/analytics/analytics.css`:

```css
.tv-eff-table__scroll {
  overflow-x: auto;
}
.tv-eff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--tv-font-sm, 0.875rem);
}
.tv-eff-table th,
.tv-eff-table td {
  padding: var(--tv-space-2, 0.5rem) var(--tv-space-3, 0.75rem);
  text-align: right;
  white-space: nowrap;
  border-bottom: 1px solid var(--tv-border, rgba(128, 128, 128, 0.2));
}
.tv-eff-table__session {
  text-align: left;
}
.tv-eff-table__sort {
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
  font: inherit;
  padding: 0;
}
.tv-eff-table__sort.is-active {
  font-weight: 600;
}
.tv-eff-table__link {
  display: flex;
  flex-direction: column;
  text-decoration: none;
  color: inherit;
}
.tv-eff-table__title {
  font-weight: 500;
}
.tv-eff-table__meta {
  font-size: var(--tv-font-xs, 0.75rem);
  color: var(--tv-text-muted, #888);
}
.tv-eff-table__median td {
  font-weight: 600;
  border-top: 2px solid var(--tv-border, rgba(128, 128, 128, 0.3));
  border-bottom: none;
}
```

> If any `--tv-*` custom property used above does not exist in the theme, substitute the nearest existing token (grep `packages/web/src` for `--tv-` to see the palette); do not introduce new global tokens.

- [ ] **Step 6: Verify build + typecheck**

Run: `npm run typecheck && npm run build`
Expected: PASS (web + server build clean).

- [ ] **Step 7: Manual check**

Run: `npm start`, open `http://localhost:4317/analytics`, switch to **Session efficiency**. Confirm: the table lists sessions with the four ratios + median footer; clicking a header re-sorts; the min-responses input filters; clicking a row opens the session. Then stop the app (kill the `concurrently`/server supervisor, not just the port).

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/api/client.ts packages/web/src/pages/analytics/
git commit -m "feat(web): add Session-efficiency analytics view"
```

---

### Task 4: Finalize

- [ ] **Step 1: Flip the plan status + record the PR**

In `docs/plans/0027-session-efficiency-analytics.md`, set `Status:` to `in-progress` and fill the `PR:` line once the PR is opened. (Mark `done` when the PR is created, per the repo convention.)

- [ ] **Step 2: Full verification**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/session-efficiency-analytics
gh pr create --fill --base main --title "feat: session-efficiency analytics view"
```

Link `docs/plans/0027-session-efficiency-analytics.md` in the PR body.

---

## Self-Review

**1. Spec coverage** (against `docs/plans/0027`):
- Dedicated `/api/analytics/sessions` endpoint → Task 2. ✓
- Reuse analytics semantics (`type='assistant'`, `usage_canonical`, 3-term cache-hit) → Task 2 CTE. ✓
- Denominator `D` = deduped responses; 4 ratios → Task 2. ✓
- Date filter by `started_at` → Task 2 (`fromClause`/`toClause` on `s.started_at`). ✓
- `minResponses` default 1, clamped ≥1 → `clampInt(..., 1, 1, ...)`. ✓
- Median over full filtered set → Task 2 summary query over `derived`. ✓
- Full sortable grid + median footer → Task 3 `SessionEfficiencyTable`. ✓
- `Overview | Session efficiency` view switch, shared date range → Task 3 step 4. ✓
- Server-side sort + Top-N (`limit` 50), deterministic tiebreak → Task 2 `ORDER BY … started_at DESC, session_id`. ✓
- Rows deep-link to session → Task 3 `<Link to={`/sessions/${id}`}>`. ✓
- Tests: ratio guards, dedup invariant, median-over-set, floor + degenerate exclusion, date filter, sort → Task 2 test cases. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — every step has concrete code/commands. The one conditional instruction (substitute a `--tv-*` token if absent) is a guarded fallback, not a placeholder. ✓

**3. Type consistency:** `SessionEfficiencyRow` field names are identical across Task 1 (definition), Task 2 (server map), and Task 3 (table render). `SessionEfficiencySort` union members match `SORT_EXPR` keys and the table `COLUMNS[].key`. `api.sessionEfficiency` return type matches the route's `SessionEfficiencyResponse`. ✓
