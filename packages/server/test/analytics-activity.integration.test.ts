import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'claudescope-act-'));
const projectsDir = join(work, 'projects');
const codexDir = join(work, 'codex');
process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = codexDir;
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

let app: import('fastify').FastifyInstance;
let closeConnection: typeof import('../src/db/duckdb.js').closeConnection;

beforeAll(async () => {
  const projA = join(projectsDir, 'enc-act');
  mkdirSync(projA, { recursive: true });
  const base = { sessionId: 'sA', cwd: '/tmp/act', gitBranch: 'main', version: '2.1.0' };
  // Two user prompts at 23:30 UTC on consecutive days. With offset +60 (CET-ish),
  // local time is 00:30 the NEXT day → isodow shifts and hour = 0.
  writeFileSync(
    join(projA, 'sA.jsonl'),
    jsonl([
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-06-01T23:30:00.000Z', isSidechain: false, message: { role: 'user', content: 'one' } },
      { ...base, type: 'user', uuid: 'u2', parentUuid: 'u1', timestamp: '2026-06-02T23:30:00.000Z', isSidechain: false, message: { role: 'user', content: 'two' } },
      // sidechain + fork-copy prompts must not count toward heatmap/streak.
      // Sidechain: a subagent-internal user turn at the same hour — must be excluded.
      { ...base, type: 'user', uuid: 'u3', parentUuid: 'u2', timestamp: '2026-06-02T23:30:00.000Z', isSidechain: true, message: { role: 'user', content: 'subagent turn' } },
      // Fork-copy: a user row in a forked session carrying forkedFrom — must be excluded.
      { ...base, sessionId: 'sB', type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-06-01T23:30:00.000Z', isSidechain: false, forkedFrom: { sessionId: 'sA', messageUuid: 'u1' }, message: { role: 'user', content: 'one (fork copy)' } },
    ]),
  );
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

describe('GET /api/analytics/activity', () => {
  it('buckets user prompts by LOCAL hour using the offset', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/activity?tzOffsetMinutes=60&today=2026-06-03' });
    const body = res.json() as { heatmap: { dow: number; hour: number; count: number }[]; streak: { current: number; longest: number } };
    // 23:30Z + 60min = 00:30 local → hour 0, two prompts on (local) June 2 and 3.
    // sidechain + fork-copy prompts must not count — count must remain 2, not 3 or 4.
    const atHour0 = body.heatmap.filter((c) => c.hour === 0).reduce((n, c) => n + c.count, 0);
    expect(atHour0).toBe(2);
    expect(body.heatmap.every((c) => c.dow >= 1 && c.dow <= 7)).toBe(true);
  });
  it('reports an all-time streak relative to the supplied today', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/activity?tzOffsetMinutes=60&today=2026-06-03' });
    const body = res.json() as { streak: { current: number; longest: number; lastActiveDay: string } };
    // local active days: 2026-06-02, 2026-06-03 → longest 2; today 06-03 → current 2.
    // sidechain + fork-copy prompts must not inflate or alter the streak.
    expect(body.streak.longest).toBe(2);
    expect(body.streak.current).toBe(2);
    expect(body.streak.lastActiveDay).toBe('2026-06-03');
  });
});
