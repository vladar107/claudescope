import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'claudescope-tools-'));
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
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

let app: import('fastify').FastifyInstance;
let closeConnection: typeof import('../src/db/duckdb.js').closeConnection;

beforeAll(async () => {
  const projA = join(projectsDir, 'enc-tools');
  mkdirSync(projA, { recursive: true });
  const base = { sessionId: 'sT', cwd: '/tmp/tools', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(projA, 'sT.jsonl'),
    jsonl([
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-06-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'go' } },
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-06-01T10:00:01.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', id: 'm1', content: [
        { type: 'tool_use', id: 't1', name: 'Edit', input: {} },
        { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
        { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
      ], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]),
  );
  // Fork-copy session: same message.id 'm1', same tool_use blocks, carrying forkedFrom.
  // Every copied row keeps the marker, so the fork filter drops the whole copy —
  // proving the fork exclusion is load-bearing.
  const forkBase = { sessionId: 'sTF', cwd: '/tmp/tools', gitBranch: 'main', version: '2.1.0' };
  const forkFrom = { sessionId: 'sT', messageUuid: 'a1' };
  writeFileSync(
    join(projA, 'sTF.jsonl'),
    jsonl([
      { ...forkBase, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-06-01T10:00:00.000Z', isSidechain: false, forkedFrom: forkFrom, message: { role: 'user', content: 'go' } },
      { ...forkBase, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-06-01T10:00:01.000Z', isSidechain: false, forkedFrom: forkFrom, message: { role: 'assistant', model: 'claude-opus-4-8', id: 'm1', content: [
        { type: 'tool_use', id: 't1', name: 'Edit', input: {} },
        { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
        { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
      ], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]),
  );

  // Session with one Skill call, plus a fork copy sharing message.id 'm2'.
  // Same fork-dedup story as the tools case above: kind=skill must still count
  // the skill once, not twice.
  const skillBase = { sessionId: 'sS', cwd: '/tmp/tools', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(projA, 'sS.jsonl'),
    jsonl([
      { ...skillBase, type: 'user', uuid: 'su1', parentUuid: null, timestamp: '2026-06-01T11:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'search history' } },
      { ...skillBase, type: 'assistant', uuid: 'sa1', parentUuid: 'su1', timestamp: '2026-06-01T11:00:01.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', id: 'm2', content: [
        { type: 'tool_use', id: 't4', name: 'Skill', input: { skill: 'claudescope:history' } },
      ], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]),
  );
  const skillForkBase = { sessionId: 'sSF', cwd: '/tmp/tools', gitBranch: 'main', version: '2.1.0' };
  const skillForkFrom = { sessionId: 'sS', messageUuid: 'sa1' };
  writeFileSync(
    join(projA, 'sSF.jsonl'),
    jsonl([
      { ...skillForkBase, type: 'user', uuid: 'su1', parentUuid: null, timestamp: '2026-06-01T11:00:00.000Z', isSidechain: false, forkedFrom: skillForkFrom, message: { role: 'user', content: 'search history' } },
      { ...skillForkBase, type: 'assistant', uuid: 'sa1', parentUuid: 'su1', timestamp: '2026-06-01T11:00:01.000Z', isSidechain: false, forkedFrom: skillForkFrom, message: { role: 'assistant', model: 'claude-opus-4-8', id: 'm2', content: [
        { type: 'tool_use', id: 't4', name: 'Skill', input: { skill: 'claudescope:history' } },
      ], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]),
  );
  // Split message: two assistant rows share message.id 'm3' with identical usage,
  // so the canonical election falls to the uuid tiebreak and 'sp-a' (text only)
  // wins. The tool_use blocks live on the non-canonical 'sp-b' — the common shape
  // in real transcripts, and invisible to this endpoint under a usage_canonical filter.
  const splitBase = { sessionId: 'sP', cwd: '/tmp/tools', gitBranch: 'main', version: '2.1.0' };
  const splitUsage = { input_tokens: 3, output_tokens: 2 };
  writeFileSync(
    join(projA, 'sP.jsonl'),
    jsonl([
      { ...splitBase, type: 'user', uuid: 'spu1', parentUuid: null, timestamp: '2026-06-01T12:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'find it' } },
      { ...splitBase, type: 'assistant', uuid: 'sp-a', parentUuid: 'spu1', timestamp: '2026-06-01T12:00:01.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', id: 'm3', content: [
        { type: 'text', text: 'Looking for the config.' },
      ], usage: splitUsage } },
      { ...splitBase, type: 'assistant', uuid: 'sp-b', parentUuid: 'sp-a', timestamp: '2026-06-01T12:00:02.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', id: 'm3', content: [
        { type: 'tool_use', id: 't5', name: 'Glob', input: {} },
        { type: 'tool_use', id: 't6', name: 'Skill', input: { skill: 'claudescope:verify' } },
      ], usage: splitUsage } },
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

describe('GET /api/analytics/tools', () => {
  it('scopes to a project slug (shared resolution; bogus slug matches nothing)', async () => {
    const { projectIdFromCwd } = await import('../src/data/project-id.js');
    const slug = projectIdFromCwd('/tmp/tools');
    const scoped = (await app.inject({ method: 'GET', url: `/api/analytics/tools?project=${encodeURIComponent(slug)}` })).json() as { rows: unknown[] };
    const all = (await app.inject({ method: 'GET', url: '/api/analytics/tools' })).json() as { rows: unknown[] };
    expect(scoped.rows.length).toBe(all.rows.length);
    const none = (await app.inject({ method: 'GET', url: '/api/analytics/tools?project=no-such-project' })).json() as { rows: unknown[] };
    expect(none.rows.length).toBe(0);
  });


  it('counts each tool occurrence (unnested), descending', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/tools' });
    const body = res.json() as { rows: { tool: string; agent: string; count: number }[] };
    const sumTool = (t: string) => body.rows.filter((r) => r.tool === t).reduce((n, r) => n + r.count, 0);
    // The fork-copy row shares message.id 'm1' and carries the same [Edit, Edit, Bash]
    // blocks, but is excluded as a fork copy. Counts must remain Edit=2 and Bash=1,
    // not 4 and 2 — proving the fork exclusion is load-bearing.
    expect(sumTool('Edit')).toBe(2);
    expect(sumTool('Bash')).toBe(1);
    // Each row is attributed to the agent that emitted it (here, all Claude Code).
    expect(body.rows.every((r) => r.agent === 'claude-code')).toBe(true);
    // descending
    expect(body.rows[0]?.count).toBeGreaterThanOrEqual(body.rows[body.rows.length - 1]?.count ?? 0);
  });

  it('kind=skill counts the skill argument of Skill calls, deduped across a fork', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/tools?kind=skill' });
    const body = res.json() as { rows: { tool: string; agent: string; count: number }[] };
    // The fork-copy session shares message.id 'm2' and the same Skill call, but
    // carries the fork marker — the count must stay 1, not 2.
    expect(body.rows.filter((r) => r.tool === 'claudescope:history')).toEqual([
      { tool: 'claudescope:history', agent: 'claude-code', count: 1 },
    ]);
  });

  it('counts calls that sit on the non-canonical row of a split message', async () => {
    const tools = (await app.inject({ method: 'GET', url: '/api/analytics/tools' })).json() as { rows: { tool: string; count: number }[] };
    const skills = (await app.inject({ method: 'GET', url: '/api/analytics/tools?kind=skill' })).json() as { rows: { tool: string; count: number }[] };
    // Both blocks live on 'sp-b', the row the usage election did NOT pick.
    expect(tools.rows.find((r) => r.tool === 'Glob')?.count).toBe(1);
    expect(skills.rows.find((r) => r.tool === 'claudescope:verify')?.count).toBe(1);
  });

  it('kind=bogus is rejected', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/tools?kind=bogus' });
    expect(res.statusCode).toBe(400);
  });

  it('a repeated kind param is rejected (an array, not a string)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/tools?kind=tool&kind=skill' });
    expect(res.statusCode).toBe(400);
  });
});
