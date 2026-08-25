/**
 * Query-param validation — the params that used to reach SQL unchecked.
 *
 * Three things are pinned here:
 *
 *  1. **Sort allowlists are prototype-safe.** Both sort gates used `key in TABLE`,
 *     which walks `Object.prototype`, so `?sort=toString` passed the gate and a
 *     `Function` was interpolated into `ORDER BY` — a 500 quoting the generated
 *     SQL. Unknown values must still fall back to the default (real clients rely
 *     on that), so these assert 200 + default ordering, not 400.
 *
 *  2. **Date bounds are validated.** `sqlString` makes them injection-safe but
 *     not castable, so `?from=not-a-date` was a DuckDB conversion error. Every
 *     bounded endpoint now answers 400. The list is exhaustive on purpose:
 *     validation lives in `scopeFilters`, and this is what proves the chokepoint
 *     really covers all of them.
 *
 *  3. **Bound SEMANTICS survived consolidation.** Four routes had their own
 *     hand-rolled bound filters and now share `scopeFilters`. Three of them
 *     filter the EVENT timestamp while the shared default is the SESSION start —
 *     a missed `ts` override would silently change what a date range means, and
 *     no existing test would notice. The fixture makes the two answers differ, so
 *     these assertions fail if the override is dropped.
 *
 * Plus: a 500 must not carry the generated SQL.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isoDayParam } from '../src/params.js';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-params-'));
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

const DAY1 = '2026-03-01';
const DAY2 = '2026-03-02';

/**
 * Two sessions, arranged so "filter by event timestamp" and "filter by session
 * start" give DIFFERENT answers:
 *  - `sOld`  starts on DAY1 and has one event on DAY1 and one on DAY2;
 *  - `sNew`  starts on DAY2 with a single DAY2 event.
 * So `from=DAY2` sees 3 events but only 1 session-started-on-or-after.
 */
function writeFixtures(): void {
  const proj = join(projectsDir, 'enc-projQ');
  mkdirSync(proj, { recursive: true });

  const ev = (session: string, uuid: string, day: string, text: string): unknown => ({
    sessionId: session,
    cwd: '/tmp/projQ',
    gitBranch: 'main',
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp: `${day}T12:00:00.000Z`,
    isSidechain: false,
    message: {
      role: 'assistant',
      id: `m-${uuid}`,
      model: 'claude-opus-4-8',
      content: [{ type: 'tool_use', id: `t-${uuid}`, name: 'Read', input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    text,
  });
  const userEv = (session: string, uuid: string, day: string): unknown => ({
    sessionId: session,
    cwd: '/tmp/projQ',
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp: `${day}T11:59:00.000Z`,
    isSidechain: false,
    message: { role: 'user', content: 'hello' },
  });

  const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

  writeFileSync(
    join(proj, 'sOld.jsonl'),
    jsonl([
      userEv('sOld', 'o-u1', DAY1),
      ev('sOld', 'o-a1', DAY1, 'day one'),
      ev('sOld', 'o-a2', DAY2, 'day two'),
    ]),
  );
  writeFileSync(
    join(proj, 'sNew.jsonl'),
    jsonl([userEv('sNew', 'n-u1', DAY2), ev('sNew', 'n-a1', DAY2, 'day two')]),
  );
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

const get = (url: string) => app.inject({ method: 'GET', url });

describe('sort allowlists are prototype-safe', () => {
  // `in` matched every one of these on Object.prototype.
  const protoKeys = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];

  it.each(protoKeys)('GET /api/sessions?sort=%s falls back instead of 500ing', async (key) => {
    const res = await get(`/api/sessions?sort=${key}`);
    expect(res.statusCode).toBe(200);
    // Same ordering as the default (`recent`), i.e. the key was truly ignored.
    const def = await get('/api/sessions');
    expect(res.json()).toEqual(def.json());
  });

  it.each(protoKeys)(
    'GET /api/analytics/sessions?sort=%s falls back instead of 500ing',
    async (key) => {
      const res = await get(`/api/analytics/sessions?sort=${key}`);
      expect(res.statusCode).toBe(200);
      const def = await get('/api/analytics/sessions');
      expect(res.json()).toEqual(def.json());
    },
  );
});

describe('date bounds are validated at every bounded endpoint', () => {
  // Exhaustive: proves validating inside scopeFilters really covers them all.
  const bounded = [
    '/api/analytics',
    '/api/analytics/sessions',
    '/api/analytics/agents',
    '/api/analytics/activity',
    '/api/analytics/tools',
    '/api/analytics/impact',
    '/api/analytics/errors',
    '/api/analytics/digest',
  ];

  it.each(bounded)('%s?from=not-a-date → 400', async (path) => {
    const res = await get(`${path}?from=not-a-date`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^from must be/);
  });

  it.each(bounded)('%s?to=not-a-date → 400', async (path) => {
    const res = await get(`${path}?to=not-a-date`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^to must be/);
  });

  it.each(['2026-13-45', '2026-02-29', '2026-02-30', '2026-04-31'])(
    'rejects the impossible calendar date %s',
    async (value) => {
      // These pass or probe beyond a naive shape check; some are normalized by
      // Date.parse even though DuckDB rejects the original string.
      const res = await get(`/api/analytics?from=${value}`);
      expect(res.statusCode).toBe(400);
    },
  );

  it('ignores an impossible optional today anchor instead of normalizing it', () => {
    expect(isoDayParam('2026-02-31')).toBeUndefined();
  });

  it('accepts a real leap day', async () => {
    const res = await get('/api/analytics?from=2028-02-29');
    expect(res.statusCode).toBe(200);
    expect(isoDayParam('2028-02-29')).toBe('2028-02-29');
  });

  it('rejects an impossible calendar date inside a full timestamp', async () => {
    const res = await get('/api/analytics?from=2026-02-31T12:00:00.000Z');
    expect(res.statusCode).toBe(400);
  });

  it('never echoes the query or SQL back to the client', async () => {
    const res = await get('/api/analytics?from=%27%29%20OR%201%3D1--');
    expect(res.statusCode).toBe(400);
    const body = res.body;
    expect(body).not.toMatch(/SELECT|FROM events|::TIMESTAMP/i);
  });

  it.each([DAY1, `${DAY1}T00:00:00.000Z`, `${DAY1} 00:00:00`, `${DAY1}T00:00:00+02:00`])(
    'accepts the format %s',
    async (value) => {
      const res = await get(`/api/analytics?from=${encodeURIComponent(value)}`);
      expect(res.statusCode).toBe(200);
    },
  );
});

describe('string enum params are validated at the HTTP boundary', () => {
  it('rejects an unsupported analytics grouping', async () => {
    const res = await get('/api/analytics?groupBy=garbage');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^groupBy must be one of/);
  });

  it.each([
    ['type', 'garbage'],
    ['scope', 'garbage'],
  ])('rejects unsupported search %s=%s', async (field, value) => {
    const res = await get(`/api/search?q=day&${field}=${value}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(new RegExp(`^${field} must be one of`));
  });
});

describe('bound semantics survived the scopeFilters consolidation', () => {
  // The fixture is built so event-level and session-level bounds DISAGREE; each
  // assertion below fails if a route lost its `ts` override (or gained one).
  it('/api/analytics bounds the EVENT timestamp', async () => {
    const all = await get('/api/analytics?groupBy=day');
    expect(all.statusCode).toBe(200);
    // Two distinct days of assistant events across both sessions.
    expect(all.json().rows.map((r: { key: string }) => r.key).sort()).toEqual([DAY1, DAY2]);

    const day2 = await get(`/api/analytics?groupBy=day&from=${DAY2}&to=${DAY2}`);
    expect(day2.statusCode).toBe(200);
    expect(day2.json().rows.map((r: { key: string }) => r.key)).toEqual([DAY2]);
    // sOld's DAY2 event is included even though sOld STARTED on DAY1 — that is
    // the event-level semantics this route must keep.
    expect(day2.json().totals.messageCount).toBe(2);
  });

  it('keeps a full timestamp upper bound inclusive', async () => {
    const to = encodeURIComponent(`${DAY1}T12:00:00.000Z`);
    const res = await get(`/api/analytics?groupBy=day&to=${to}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: { key: string }) => r.key)).toEqual([DAY1]);
    expect(res.json().totals.messageCount).toBe(1);
  });

  it('/api/analytics/sessions bounds the SESSION START', async () => {
    const all = await get('/api/analytics/sessions');
    expect(all.json().rows).toHaveLength(2);

    const day2 = await get(`/api/analytics/sessions?from=${DAY2}`);
    // Only sNew started on DAY2; sOld is excluded despite having a DAY2 event.
    expect(day2.json().rows.map((r: { sessionId: string }) => r.sessionId)).toEqual(['sNew']);
  });

  it('/api/analytics/tools bounds the EVENT timestamp', async () => {
    const all = await get('/api/analytics/tools');
    const total = (body: { rows: { count: number }[] }): number =>
      body.rows.reduce((n, r) => n + r.count, 0);
    expect(total(all.json())).toBe(3); // one Read per assistant event

    const day2 = await get(`/api/analytics/tools?from=${DAY2}`);
    expect(total(day2.json())).toBe(2); // sOld's DAY2 call + sNew's
  });

  it('/api/analytics/activity bounds the EVENT timestamp', async () => {
    const all = await get('/api/analytics/activity?tzOffsetMinutes=0');
    const cells = (body: { heatmap: { count: number }[] }): number =>
      body.heatmap.reduce((n, c) => n + c.count, 0);
    expect(cells(all.json())).toBe(2); // one user prompt per session

    const day2 = await get(`/api/analytics/activity?tzOffsetMinutes=0&from=${DAY2}`);
    expect(cells(day2.json())).toBe(1); // only sNew's prompt is on DAY2
  });

  it('/api/analytics/digest bounds the SESSION START', async () => {
    const all = await get(`/api/analytics/digest?from=${DAY1}&to=${DAY2}`);
    expect(all.json().totals.sessions).toBe(2);

    const day2 = await get(`/api/analytics/digest?from=${DAY2}&to=${DAY2}`);
    expect(day2.statusCode).toBe(200);
    expect(day2.json().totals.sessions).toBe(1);
  });
});

describe('the error handler', () => {
  it('collapses an unexpected error to a generic 500 without internals', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerErrorHandler } = await import('../src/routes/index.js');
    // `logger: false` keeps the deliberate error out of the test output; the
    // production instance logs it via req.log.error.
    const bare = Fastify({ logger: false });
    registerErrorHandler(bare);
    bare.get('/boom', async () => {
      throw new Error("Parser Error: syntax error at or near \"x\"\nLINE 1: SELECT * FROM events");
    });
    await bare.ready();

    const res = await bare.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    expect(res.body).not.toMatch(/Parser Error|SELECT|events/i);
    await bare.close();
  });
});
