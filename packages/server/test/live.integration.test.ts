/**
 * Live-tab integration tests — GET /api/live and /api/live/count: window
 * selection by live file mtime, newest-first ordering, the cap, the stat-only
 * count, and the derived-state cache (reused while files are unchanged,
 * re-derived on append with NO reindex).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { LiveCountResponse, LiveResponse } from '@claudescope/shared';

vi.mock('../src/db/duckdb.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/db/duckdb.js')>();
  return { ...mod, queryRows: vi.fn(mod.queryRows) };
});

const work = mkdtempSync(join(tmpdir(), 'claudescope-live-'));
const projectsDir = join(work, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
const grokDir = join(work, 'grok');
process.env.GROK_SESSIONS_DIR = grokDir;
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const MIN = 60_000;

function sessionLines(id: string, tailText = 'all done'): unknown[] {
  const base = { sessionId: id, cwd: '/tmp/projLive', gitBranch: 'main', version: '2.1.0', isSidechain: false };
  const ts = (s: number) => new Date(Date.now() - 600_000 + s * 1000).toISOString();
  return [
    { ...base, type: 'user', uuid: `${id}-u1`, parentUuid: null, timestamp: ts(0), message: { role: 'user', content: `start ${id}` } },
    { ...base, type: 'assistant', uuid: `${id}-a1`, parentUuid: `${id}-u1`, timestamp: ts(5), message: { role: 'assistant', model: 'claude-opus-4-8', id: `${id}-m1`, content: [{ type: 'text', text: tailText }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
}

function writeSession(id: string, ageMs: number): string {
  const dir = join(projectsDir, 'enc-projLive');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, jsonl(sessionLines(id)));
  const t = new Date(Date.now() - ageMs);
  utimesSync(file, t, t);
  return file;
}

function writeGrokSession(id: string): void {
  const dir = join(grokDir, '%2Ftmp%2FprojLive', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({ info: { id, cwd: '/tmp/projLive' }, created_at: new Date().toISOString(), current_model_id: 'grok-4.5' }),
  );
  writeFileSync(
    join(dir, 'chat_history.jsonl'),
    jsonl([
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_query>\nhello grok\n</user_query>' }] },
      { type: 'assistant', content: 'hi there', model_id: 'grok-4.5' },
    ]),
  );
}

let app: FastifyInstance;
let reindex: typeof import('../src/data/index.js').reindex;
let closeConnection: () => Promise<void>;
let queryRows: ReturnType<typeof vi.fn>;
let loadSession: ReturnType<typeof vi.spyOn>;
let cacheFile: string;

beforeAll(async () => {
  writeSession('sessOld', 20 * MIN);
  writeSession('sessMid', 5 * MIN);
  writeSession('sessNew', 1 * MIN);
  cacheFile = writeSession('sessCache', 2 * MIN);
  writeGrokSession('grokLive');

  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  ({ reindex } = await import('../src/data/index.js'));
  ({ closeConnection } = await import('../src/db/duckdb.js'));
  queryRows = (await import('../src/db/duckdb.js')).queryRows as unknown as ReturnType<typeof vi.fn>;
  const { connectorById } = await import('../src/connectors/registry.js');
  loadSession = vi.spyOn(connectorById('claude-code'), 'loadSession');
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

const getLive = async (q = '') => (await app.inject({ method: 'GET', url: `/api/live${q}` })).json() as LiveResponse;
const getCount = async (q = '') =>
  (await app.inject({ method: 'GET', url: `/api/live/count${q}` })).json() as LiveCountResponse;
const loadsOf = (id: string): number =>
  loadSession.mock.calls.filter((c: unknown[]) => c[0] === id).length;

describe('GET /api/live', () => {
  it('excludes sessions older than the window, orders newest write first, and widens with windowMin', async () => {
    const live = await getLive('?windowMin=15');
    expect(live.windowMinutes).toBe(15);
    expect(live.sessions.map((s) => s.meta.id)).toEqual(['grokLive', 'sessNew', 'sessCache', 'sessMid']);

    const wide = await getLive('?windowMin=60');
    expect(wide.sessions.map((s) => s.meta.id)).toContain('sessOld');
    expect(wide.sessions.at(-1)?.meta.id).toBe('sessOld');
  });

  it('falls back to the default window for values outside the allowed set', async () => {
    const res = await getLive('?windowMin=999');
    expect(res.windowMinutes).toBe(15);
    expect(res.sessions.map((s) => s.meta.id)).not.toContain('sessOld');
    expect((await getCount('?windowMin=junk')).windowMinutes).toBe(15);
  });

  it('keeps a figure absent exactly when the agent cannot record it', async () => {
    const { hasPromptSizedUsage } = await import('../src/data/agent-capabilities.js');
    const s = (await getLive()).sessions[0]!;
    expect(s.meta.contextTokens !== undefined).toBe(hasPromptSizedUsage(s.meta.connectorId));
  });

  it('reports no context for an agent without prompt-sized usage', async () => {
    const { usageGranularity } = await import('../src/data/agent-capabilities.js');
    const grok = (await getLive()).sessions.find((x) => x.meta.id === 'grokLive')!;
    expect(grok.meta.connectorId).toBe('grok');
    expect(grok.meta.contextTokens).toBeUndefined();
    expect(grok.usageGranularity).toBe(usageGranularity('grok'));
  });

  it('reuses the derived result while files are unchanged and re-derives on append without a reindex', async () => {
    const first = (await getLive()).sessions.find((s) => s.meta.id === 'sessCache')!;
    expect(first.state).toBe('idle');
    const loads = loadsOf('sessCache');
    await getLive();
    expect(loadsOf('sessCache')).toBe(loads);

    const realNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 45_000);
    try {
      await getLive();
    } finally {
      clock.mockRestore();
    }
    expect(loadsOf('sessCache')).toBe(loads);

    appendFileSync(
      cacheFile,
      jsonl([
        {
          sessionId: 'sessCache', cwd: '/tmp/projLive', isSidechain: false, type: 'assistant', uuid: 'sessCache-a2',
          parentUuid: 'sessCache-a1', timestamp: new Date().toISOString(),
          message: { role: 'assistant', model: 'claude-opus-4-8', id: 'sessCache-m2', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'sleep 9' } }], usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ]),
    );
    const after = (await getLive()).sessions.find((s) => s.meta.id === 'sessCache')!;
    expect(after.state).toBe('tool');
    expect(after.openTool?.name).toBe('Bash');
    expect(loadsOf('sessCache')).toBe(loads + 1);
  });
});

describe('live snapshot', () => {
  it('serves from memory when nothing changed', async () => {
    await getLive();
    queryRows.mockClear();
    await getLive();
    expect(queryRows).not.toHaveBeenCalled();
  });

  it('serves a fast refresh immediately but never waits past the timeout on a slow one', async () => {
    writeSession('sessFast', 10_000);
    await reindex();
    const fast = await getLive();
    expect(fast.sessions.map((s) => s.meta.id)).toContain('sessFast');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = queryRows.getMockImplementation()!;
    writeSession('sessSlow', 10_000);
    await reindex();
    queryRows.mockImplementationOnce(async (...args: unknown[]) => {
      await gate;
      return original(...args);
    });
    const started = Date.now();
    const stale = await getLive();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(stale.sessions.map((s) => s.meta.id)).not.toContain('sessSlow');

    release();
    await vi.waitFor(async () => {
      expect((await getLive()).sessions.map((s) => s.meta.id)).toContain('sessSlow');
    });
  });
});

describe('GET /api/live/count', () => {
  it('agrees with /api/live and never loads a transcript', async () => {
    loadSession.mockClear();
    const count = await getCount();
    expect(loadSession).not.toHaveBeenCalled();
    expect(count.count).toBe((await getLive()).sessions.length);
  });
});

describe('live cap', () => {
  it('returns at most 20 sessions and reports the rest as truncated', async () => {
    for (let i = 0; i < 20; i++) writeSession(`sessBulk${i}`, 30_000);
    await reindex();
    await vi.waitFor(async () => expect((await getLive()).sessions).toHaveLength(20));
    const [live, count] = [await getLive(), await getCount()];
    expect(live.sessions).toHaveLength(20);
    expect(live.truncated).toBe(count.count - 20);
    expect(live.truncated).toBeGreaterThan(0);
  });
});
