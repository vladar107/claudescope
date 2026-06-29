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
  // The canonical-usage election prefers the original (forked_from_session_id IS NULL)
  // and marks this copy non-canonical — proving usage_canonical is load-bearing.
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
  it('counts each tool occurrence (unnested), descending', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/analytics/tools' });
    const body = res.json() as { rows: { tool: string; agent: string; count: number }[] };
    const sumTool = (t: string) => body.rows.filter((r) => r.tool === t).reduce((n, r) => n + r.count, 0);
    // The fork-copy row shares message.id 'm1' and carries the same [Edit, Edit, Bash]
    // blocks, but is marked non-canonical by usage_canonical election. Counts must
    // remain Edit=2 and Bash=1, not 4 and 2 — proving usage_canonical is load-bearing.
    expect(sumTool('Edit')).toBe(2);
    expect(sumTool('Bash')).toBe(1);
    // Each row is attributed to the agent that emitted it (here, all Claude Code).
    expect(body.rows.every((r) => r.agent === 'claude-code')).toBe(true);
    // descending
    expect(body.rows[0]?.count).toBeGreaterThanOrEqual(body.rows[body.rows.length - 1]?.count ?? 0);
  });
});
