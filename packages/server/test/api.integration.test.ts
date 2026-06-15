/**
 * End-to-end API integration tests.
 *
 * Builds a DuckDB index from a synthetic fixtures directory (a miniature
 * ~/.claude/projects) into a throwaway temp database, then exercises every
 * route through Fastify's `.inject()`. These are the tests we rely on: they
 * cover the indexer, the SQL, the thread/subagent assembly, and the routes
 * together against realistic on-disk data.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-it-'));
const projectsDir = join(work, 'projects');
const dbPath = join(work, 'index.duckdb');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
// Isolate from the real ~/.codex and ~/.junie so this Claude-only suite stays
// deterministic.
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.DUCKDB_PATH = dbPath;
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Write the fixture transcripts (two projects; sessA has subagents). */
function writeFixtures(): string[] {
  const projA = join(projectsDir, 'enc-projA');
  const projB = join(projectsDir, 'enc-projB');
  const subA = join(projA, 'sessA', 'subagents');
  const wfA = join(subA, 'workflows', 'wf_int1');
  mkdirSync(wfA, { recursive: true });
  mkdirSync(projB, { recursive: true });

  const baseA = { sessionId: 'sessA', cwd: '/tmp/projA', gitBranch: 'main', version: '2.1.0' };
  const sessA = join(projA, 'sessA.jsonl');
  writeFileSync(
    sessA,
    jsonl([
      { type: 'ai-title', sessionId: 'sessA', aiTitle: 'Session A' },
      { ...baseA, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'please find the needle in this haystack' } },
      { ...baseA, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-01-01T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'on it' }], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } },
      { ...baseA, type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: '2026-01-01T10:00:10.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { description: 'Explore the code', subagent_type: 'Explore' } }], usage: { input_tokens: 20, output_tokens: 10 } } },
      { ...baseA, type: 'user', uuid: 'u2', parentUuid: 'a2', timestamp: '2026-01-01T10:00:30.000Z', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'exploration finished' }] } },
      { ...baseA, type: 'assistant', uuid: 'a3', parentUuid: 'u2', timestamp: '2026-01-01T10:00:35.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'tu_wf', name: 'Workflow', input: { script: '...' } }], usage: { input_tokens: 30, output_tokens: 15 } } },
      { ...baseA, type: 'user', uuid: 'u3', parentUuid: 'a3', timestamp: '2026-01-01T10:02:00.000Z', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_wf', content: 'Workflow launched. Run ID: wf_int1 — done.' }] } },
      { type: 'pr-link', sessionId: 'sessA', prNumber: 7, prRepository: 'me/repo', prUrl: 'https://example/pr/7' },
    ]),
  );

  // Agent-spawned subagent (correlates by description).
  const subBase = { sessionId: 'sessA', cwd: '/tmp/projA', isSidechain: true };
  const agentA = join(subA, 'agent-aaaa.jsonl');
  writeFileSync(agentA, jsonl([
    { ...subBase, type: 'user', uuid: 'sa-u1', parentUuid: null, agentId: 'aaaa', timestamp: '2026-01-01T10:00:12.000Z', message: { role: 'user', content: 'explore please' } },
    { ...subBase, type: 'assistant', uuid: 'sa-a1', parentUuid: 'sa-u1', agentId: 'aaaa', timestamp: '2026-01-01T10:00:20.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'g1', name: 'Grep', input: {} }], usage: { input_tokens: 40, output_tokens: 20 } } },
  ]));
  writeFileSync(join(subA, 'agent-aaaa.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Explore the code' }));

  // Workflow-spawned subagent (correlates by run id, no meta description).
  const agentW = join(wfA, 'agent-wwww.jsonl');
  writeFileSync(agentW, jsonl([
    { ...subBase, type: 'user', uuid: 'sw-u1', parentUuid: null, agentId: 'wwww', timestamp: '2026-01-01T10:00:40.000Z', message: { role: 'user', content: 'Build the dashboard component' } },
    { ...subBase, type: 'assistant', uuid: 'sw-a1', parentUuid: 'sw-u1', agentId: 'wwww', timestamp: '2026-01-01T10:01:00.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'built' }], usage: { input_tokens: 60, output_tokens: 30 } } },
  ]));
  writeFileSync(join(wfA, 'agent-wwww.meta.json'), JSON.stringify({ agentType: 'workflow-subagent' }));

  // Second project / session — deliberately includes a MALFORMED line mid-file:
  // a string with an invalid JSON backslash escape (`\p`, as in an un-doubled
  // path or a `\p{…}` regex). DuckDB's strict reader rejects it at the `p`;
  // `ignore_errors=true` must skip just that line and still index the surrounding
  // valid events. Without the fix, the whole reindex throws and the suite fails.
  const sessB = join(projB, 'sessB.jsonl');
  const sessBLines = [
    JSON.stringify({ type: 'ai-title', sessionId: 'sessB', aiTitle: 'Session B' }),
    JSON.stringify({ type: 'user', sessionId: 'sessB', uuid: 'b-u1', parentUuid: null, cwd: '/tmp/projB', timestamp: '2026-01-02T09:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'hello from project B' } }),
    '{"type":"assistant","sessionId":"sessB","message":{"role":"assistant","content":"C:\\path\\to"}}',
    JSON.stringify({ type: 'assistant', sessionId: 'sessB', uuid: 'b-a1', parentUuid: 'b-u1', cwd: '/tmp/projB', timestamp: '2026-01-02T09:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-7', content: [{ type: 'text', text: 'hi B' }], usage: { input_tokens: 200, output_tokens: 100 } } }),
  ];
  writeFileSync(sessB, sessBLines.join('\n') + '\n');

  return [sessA, agentA, join(subA, 'agent-aaaa.meta.json'), agentW, join(wfA, 'agent-wwww.meta.json'), sessB];
}

let app: FastifyInstance;
let fixtureFiles: string[];
let projAId: string;
let projBId: string;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  fixtureFiles = writeFixtures();

  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');
  const { projectIdFromCwd } = await import('../src/data/project-id.js');
  ({ closeConnection } = await import('../src/db/duckdb.js'));
  projAId = projectIdFromCwd('/tmp/projA');
  projBId = projectIdFromCwd('/tmp/projB');

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

const get = async (url: string) => app.inject({ method: 'GET', url });

describe('GET /api/health', () => {
  it('reports ready after indexing', async () => {
    const res = await get('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', ready: true });
  });
});

describe('GET /api/projects', () => {
  it('returns one entry per distinct cwd with token/cost totals', async () => {
    const projects = (await get('/api/projects')).json();
    expect(projects).toHaveLength(2);
    const ids = projects.map((p: { id: string }) => p.id).sort();
    expect(ids).toEqual([projAId, projBId].sort());
    const total = projects.reduce((n: number, p: { totalTokens: number }) => n + p.totalTokens, 0);
    expect(total).toBeGreaterThan(0);
    expect(projects.every((p: { totalCostUsd: number }) => p.totalCostUsd >= 0)).toBe(true);
  });
});

describe('GET /api/sessions', () => {
  it('lists both sessions (subagent files fold into their parent session)', async () => {
    const sessions = (await get('/api/sessions')).json();
    expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual(['sessA', 'sessB']);
    const a = sessions.find((s: { id: string }) => s.id === 'sessA');
    expect(a).toMatchObject({ title: 'Session A', hasSidechain: true, prUrl: 'https://example/pr/7', connectorId: 'claude-code' });
  });

  it('filters by project id', async () => {
    const sessions = (await get(`/api/sessions?project=${projBId}`)).json();
    expect(sessions.map((s: { id: string }) => s.id)).toEqual(['sessB']);
  });

  // Regression: sessB's transcript contains a malformed JSON line (invalid `\p`
  // escape). The indexer must skip just that line, not abort the whole reindex.
  it('indexes a session despite a malformed line in its transcript', async () => {
    const detail = (await get('/api/sessions/sessB')).json();
    expect(detail.meta.id).toBe('sessB');
    // The two valid turns around the corrupt line are present; the bad line is
    // dropped (not surfaced as a phantom turn).
    expect(detail.thread.map((t: { role: string }) => t.role)).toEqual(['user', 'assistant']);
  });
});

describe('GET /api/sessions/:id', () => {
  it('assembles the main thread without inlining sidechain turns', async () => {
    const detail = (await get('/api/sessions/sessA')).json();
    expect(detail.meta.id).toBe('sessA');
    expect(detail.thread.every((t: { isSidechain: boolean }) => !t.isSidechain)).toBe(true);
  });

  it('returns subagents linked to their spawn points (Agent + Workflow)', async () => {
    const detail = (await get('/api/sessions/sessA')).json();
    expect(detail.subagents).toHaveLength(2);

    const explore = detail.subagents.find((s: { agentType: string }) => s.agentType === 'Explore');
    expect(explore.toolUseId).toBe('tu_agent');
    expect(explore.description).toBe('Explore the code');

    const wf = detail.subagents.find((s: { agentType: string }) => s.agentType === 'workflow-subagent');
    expect(wf.toolUseId).toBe('tu_wf');
    // Label derived from the first prompt since workflow agents have no meta description.
    expect(wf.description).toBe('Build the dashboard component');

    // Every linked spawnUuid must exist in the main thread.
    const uuids = new Set(detail.thread.map((t: { uuid: string }) => t.uuid));
    for (const s of detail.subagents) expect(uuids.has(s.spawnUuid)).toBe(true);
  });

  it('404s on an unknown session', async () => {
    expect((await get('/api/sessions/does-not-exist')).statusCode).toBe(404);
  });
});

describe('GET /api/search', () => {
  it('finds a session by full-text content', async () => {
    const { sessions: results } = (await get('/api/search?q=needle')).json();
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r: { sessionId: string }) => r.sessionId === 'sessA')).toBe(true);
  });
});

describe('GET /api/analytics', () => {
  it('groups by model with reconciled totals', async () => {
    const { rows, totals } = (await get('/api/analytics?groupBy=model')).json();
    const models = rows.map((r: { key: string }) => r.key).sort();
    expect(models).toEqual(['claude-opus-4-7', 'claude-opus-4-8']);
    expect(totals.totalTokens).toBeGreaterThan(0);
    const rowSum = rows.reduce((n: number, r: { totalTokens: number }) => n + r.totalTokens, 0);
    expect(rowSum).toBe(totals.totalTokens);
  });

  it('groups by project using ids that match /api/projects', async () => {
    const projectIds = new Set(
      (await get('/api/projects')).json().map((p: { id: string }) => p.id),
    );
    const { rows } = (await get('/api/analytics?groupBy=project')).json();
    expect(rows.length).toBe(projectIds.size);
    for (const r of rows) expect(projectIds.has(r.key)).toBe(true);
  });
});

describe('DTO completeness (alias-drift guard)', () => {
  // If a SELECT alias or schema column drifts, the typed row reader throws (→ a
  // failed request) or a field lands on its default. These assert each route's
  // DTO is fully populated for a known fixture, so a renamed/dropped column fails
  // loudly here instead of silently shipping 0 / '' values.
  it('/api/sessions populates every SessionMeta field for sessA', async () => {
    const sessions = (await get('/api/sessions')).json();
    const a = sessions.find((s: { id: string }) => s.id === 'sessA');
    expect(a).toMatchObject({
      id: 'sessA',
      projectId: projAId,
      title: 'Session A',
      connectorId: 'claude-code',
      hasSidechain: true,
      prUrl: 'https://example/pr/7',
      gitBranch: 'main',
    });
    expect(a.projectDisplayName.length).toBeGreaterThan(0);
    expect(a.startedAt.length).toBeGreaterThan(0);
    expect(a.endedAt.length).toBeGreaterThan(0);
    expect(a.messageCount).toBeGreaterThan(0);
    expect(a.toolCallCount).toBeGreaterThan(0);
    expect(a.totalTokens).toBeGreaterThan(0);
    expect(a.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(a.sizeBytes).toBeGreaterThan(0);
    expect(a.models.length).toBeGreaterThan(0);
  });

  it('/api/projects populates every ProjectMeta field', async () => {
    const projects = (await get('/api/projects')).json();
    const a = projects.find((p: { id: string }) => p.id === projAId);
    expect(a.cwd.length).toBeGreaterThan(0);
    expect(a.displayName.length).toBeGreaterThan(0);
    expect(a.sessionCount).toBeGreaterThan(0);
    expect(a.totalTokens).toBeGreaterThan(0);
    expect(a.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(a.lastActive.length).toBeGreaterThan(0);
    expect(a.connectorIds.length).toBeGreaterThan(0);
    expect(a.agents.length).toBeGreaterThan(0);
    expect(a.agents[0].connectorId.length).toBeGreaterThan(0);
    expect(a.agents[0].sessionCount).toBeGreaterThan(0);
  });

  it('/api/analytics populates every AnalyticsRow field', async () => {
    const { rows } = (await get('/api/analytics?groupBy=model')).json();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.key.length).toBeGreaterThan(0);
      expect(r.totalTokens).toBe(
        r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens,
      );
      expect(r.messageCount).toBeGreaterThan(0);
      expect(Number.isFinite(r.costUsd)).toBe(true);
      expect(Number.isFinite(r.cacheHitRatio)).toBe(true);
    }
    expect(rows.some((r: { inputTokens: number }) => r.inputTokens > 0)).toBe(true);
    expect(rows.some((r: { outputTokens: number }) => r.outputTokens > 0)).toBe(true);
  });

  it('/api/search populates every SearchResult field', async () => {
    const { sessions: results } = (await get('/api/search?q=needle')).json();
    const hit = results.find((r: { sessionId: string }) => r.sessionId === 'sessA');
    expect(hit.messageUuid.length).toBeGreaterThan(0);
    expect(hit.projectId).toBe(projAId);
    expect(hit.title).toBe('Session A');
    expect(hit.role.length).toBeGreaterThan(0);
    expect(hit.snippet.length).toBeGreaterThan(0);
    expect(Number.isFinite(hit.score)).toBe(true);
  });
});

describe('POST /api/reindex', () => {
  it('is incremental and reports zero changes on a clean re-run', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/reindex' });
    expect(res.statusCode).toBe(200);
    expect(res.json().reindexed).toBe(0);
  });
});

describe('stale aux row cleanup', () => {
  // Regression: if an ai-title line is removed from a transcript, the stale
  // titles row must not survive the reload and be picked up via LEFT JOIN in
  // rebuildSessions — the session title must fall back to the first user message.
  it('clears a stale ai-title when the line is removed from the transcript', async () => {
    const { reindex } = await import('../src/data/index.js');

    // Write a fresh session fixture with an ai-title line.
    const projC = join(projectsDir, 'enc-projC');
    mkdirSync(projC, { recursive: true });
    const sessC = join(projC, 'sessC.jsonl');
    writeFileSync(
      sessC,
      jsonl([
        { type: 'ai-title', sessionId: 'sessC', aiTitle: 'AI Generated Title' },
        { type: 'user', sessionId: 'sessC', uuid: 'c-u1', parentUuid: null, cwd: '/tmp/projC', timestamp: '2026-03-01T08:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'first user message for sessC' } },
        { type: 'assistant', sessionId: 'sessC', uuid: 'c-a1', parentUuid: 'c-u1', cwd: '/tmp/projC', timestamp: '2026-03-01T08:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'reply C' }], usage: { input_tokens: 10, output_tokens: 5 } } },
      ]),
    );

    await reindex();

    // Confirm the ai-title is picked up on first index.
    const before = (await get('/api/sessions/sessC')).json();
    expect(before.meta.title).toBe('AI Generated Title');

    // Rewrite the file WITHOUT the ai-title line. Change the content slightly
    // so mtime+size differ and the (mtime,size) check triggers a reload.
    writeFileSync(
      sessC,
      jsonl([
        { type: 'user', sessionId: 'sessC', uuid: 'c-u1', parentUuid: null, cwd: '/tmp/projC', timestamp: '2026-03-01T08:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'first user message for sessC' } },
        { type: 'assistant', sessionId: 'sessC', uuid: 'c-a1', parentUuid: 'c-u1', cwd: '/tmp/projC', timestamp: '2026-03-01T08:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'reply C' }], usage: { input_tokens: 10, output_tokens: 5 } } },
      ]),
    );

    await reindex();

    // The stale ai-title must be gone; title should fall back to first user message.
    const after = (await get('/api/sessions/sessC')).json();
    expect(after.meta.title).not.toBe('AI Generated Title');
    expect(after.meta.title).toContain('first user message for sessC');
  });
});

describe('read-only guarantee', () => {
  it('never modifies the source transcripts', async () => {
    const before = fixtureFiles.map((f) => statSync(f));
    await get('/api/sessions/sessA');
    await get('/api/search?q=needle');
    await app.inject({ method: 'POST', url: '/api/reindex' });
    fixtureFiles.forEach((f, i) => {
      const after = statSync(f);
      expect(after.size).toBe(before[i]!.size);
      expect(after.mtimeMs).toBe(before[i]!.mtimeMs);
    });
  });
});
