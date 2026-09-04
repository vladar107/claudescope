/**
 * Nested subagents (a subagent that spawns a subagent) — Claude Code.
 *
 * Depth-2 runs are SIBLING files in the same `<session>/subagents/` dir; only
 * the metadata says otherwise (`toolUseId` names an `Agent` call inside the
 * depth-1 transcript, `parentAgentId` names the depth-1 run). A synthetic
 * projects tree is indexed into a throwaway DuckDB and read back through the
 * real session route, because the edges here span the connector, the matcher
 * and the windowing:
 *
 *  1. the exact spawning id resolves against a call in ANOTHER run's thread,
 *     even though the child file sorts (and is therefore matched) BEFORE it;
 *  2. the same-description trap: a depth-2 run whose description equals an
 *     unused MAIN-thread call must follow its named parent, not the main call;
 *  3. legacy metadata (no ids) stays main-thread-scoped, so it goes unlinked
 *     rather than stealing a call from another run;
 *  4. a window around the main spawn turn carries the whole descendant chain,
 *     and a window elsewhere carries none of it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const work = mkdtempSync(join(tmpdir(), 'claudescope-nested-'));
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

const SESSION = 'nested';
const CWD = '/tmp/nestedproj';
const MODEL = 'claude-sonnet-4-9';
/** The description of the MAIN thread's call — reused by the trap run. */
const MAIN_DESC = 'Probe: nested subagent spawn';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

const base = { sessionId: SESSION, cwd: CWD, gitBranch: 'main', version: '2.1.0' };

const user = (
  uuid: string,
  parentUuid: string | null,
  ts: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...base, type: 'user', uuid, parentUuid, timestamp: ts, isSidechain: false,
  message: { role: 'user', content }, ...extra,
});

const asst = (
  uuid: string,
  parentUuid: string | null,
  ts: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...base, type: 'assistant', uuid, parentUuid, timestamp: ts, isSidechain: false,
  message: {
    role: 'assistant', model: MODEL, content,
    usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
  ...extra,
});

/** An `Agent` tool_use block — the spawn point a run anchors to. */
const agentCall = (id: string, description: string, prompt: string) => ({
  type: 'tool_use', id, name: 'Agent',
  input: { description, subagent_type: 'general-purpose', prompt },
});

const proj = join(projectsDir, 'enc-nestedproj');
const subDir = join(proj, SESSION, 'subagents');

/** One subagent transcript + its `agent-<id>.meta.json` sibling. */
function writeSubagent(
  agentId: string,
  meta: Record<string, unknown>,
  events: Record<string, unknown>[],
): void {
  writeFileSync(join(subDir, `agent-${agentId}.jsonl`), jsonl(events));
  writeFileSync(join(subDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));
}

/** Mark a subagent row: sidechain, carrying its own agent id (never a parent). */
const inRun = (agentId: string) => ({ isSidechain: true, agentId });

function writeFixtures(): void {
  mkdirSync(subDir, { recursive: true });

  writeFileSync(
    join(proj, `${SESSION}.jsonl`),
    jsonl([
      user('m-u1', null, '2026-04-01T10:00:00.000Z', 'kick off the nesting probe'),
      asst('m-a1', 'm-u1', '2026-04-01T10:00:05.000Z', [
        agentCall('toolu_main', MAIN_DESC, 'probe the nesting'),
      ]),
      user('m-u2', 'm-a1', '2026-04-01T10:01:00.000Z', [
        { type: 'tool_result', tool_use_id: 'toolu_main', content: 'probe finished' },
      ]),
      asst('m-a2', 'm-u2', '2026-04-01T10:01:05.000Z', [{ type: 'text', text: 'all done' }]),
    ]),
  );

  // Depth 1: spawned by the main thread's `toolu_main`, and itself the spawner
  // of every depth-2 run below.
  writeSubagent(
    'p1',
    { agentType: 'general-purpose', description: MAIN_DESC, toolUseId: 'toolu_main', spawnDepth: 1, model: 'sonnet' },
    [
      { ...user('p1-u1', null, '2026-04-01T10:00:06.000Z', 'probe the nesting'), ...inRun('p1') },
      { ...asst('p1-a1', 'p1-u1', '2026-04-01T10:00:10.000Z', [
        agentCall('toolu_nested', 'nested probe', 'do the nested work'),
      ]), ...inRun('p1') },
      { ...asst('p1-a2', 'p1-a1', '2026-04-01T10:00:20.000Z', [
        // Same description as the MAIN thread's call — the trap.
        agentCall('toolu_trap', MAIN_DESC, 'trap probe'),
        agentCall('toolu_legacy', 'nested probe', 'legacy nested work'),
      ]), ...inRun('p1') },
      { ...asst('p1-a3', 'p1-a2', '2026-04-01T10:00:50.000Z', [
        { type: 'text', text: 'depth-1 summary' },
      ]), ...inRun('p1') },
    ],
  );

  // Depth 2, exact id: `toolu_nested` lives in p1's thread, not the main one.
  // Sorts before `agent-p1.jsonl`, so it is matched before its parent exists
  // as a run — the matcher must assemble every run before correlating any.
  writeSubagent(
    'c1',
    { agentType: 'general-purpose', description: 'nested probe', toolUseId: 'toolu_nested', parentAgentId: 'p1', spawnDepth: 2, model: 'sonnet' },
    [
      { ...user('c1-u1', null, '2026-04-01T10:00:11.000Z', 'do the nested work'), ...inRun('c1') },
      { ...asst('c1-a1', 'c1-u1', '2026-04-01T10:00:15.000Z', [
        { type: 'text', text: 'grandchild kaleidoscope report' },
      ]), ...inRun('c1') },
    ],
  );

  // Depth 2, description only (no `toolUseId`): its description equals the main
  // thread's still-unmatched call, so only the named parent keeps it honest.
  writeSubagent(
    'c2',
    { agentType: 'general-purpose', description: MAIN_DESC, parentAgentId: 'p1', spawnDepth: 2, model: 'sonnet' },
    [
      { ...user('c2-u1', null, '2026-04-01T10:00:21.000Z', 'trap probe'), ...inRun('c2') },
      { ...asst('c2-a1', 'c2-u1', '2026-04-01T10:00:25.000Z', [
        { type: 'text', text: 'trap run report' },
      ]), ...inRun('c2') },
    ],
  );

  // Depth 2 written by an older Claude Code: no ids at all. Its spawning call
  // (`toolu_legacy`) is in p1's thread, which legacy metadata can never reach.
  writeSubagent(
    'legacy',
    { agentType: 'general-purpose', description: 'nested probe' },
    [
      { ...user('lg-u1', null, '2026-04-01T10:00:22.000Z', 'legacy nested work'), ...inRun('legacy') },
      { ...asst('lg-a1', 'lg-u1', '2026-04-01T10:00:26.000Z', [
        { type: 'text', text: 'legacy run report' },
      ]), ...inRun('legacy') },
    ],
  );
}

interface Run {
  agentId: string;
  toolUseId?: string;
  spawnUuid?: string;
  parentAgentId?: string;
  thread: unknown[];
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
const runsOf = async (url: string): Promise<Run[]> => (await get(url)).json().subagents;
const byId = (runs: Run[], id: string): Run =>
  runs.find((r) => r.agentId === id) as Run;

describe('nested Claude Code subagents', () => {
  it('links a depth-2 run to the Agent call inside its parent run', async () => {
    const runs = await runsOf(`/api/sessions/${SESSION}`);
    expect(runs.map((r) => r.agentId).sort()).toEqual(['c1', 'c2', 'legacy', 'p1']);

    // Depth 1 anchors in the main thread and names no parent.
    expect(byId(runs, 'p1')).toMatchObject({ toolUseId: 'toolu_main', spawnUuid: 'm-a1' });
    expect(byId(runs, 'p1').parentAgentId).toBeUndefined();

    // Depth 2 anchors at the call inside p1's thread.
    expect(byId(runs, 'c1')).toMatchObject({
      toolUseId: 'toolu_nested',
      parentAgentId: 'p1',
      spawnUuid: 'p1-a1',
    });
    expect(JSON.stringify(byId(runs, 'c1').thread)).toContain('grandchild kaleidoscope report');
  });

  it('keeps a same-description nested run under its named parent', async () => {
    const runs = await runsOf(`/api/sessions/${SESSION}`);
    // Without parent scoping this would have matched the main thread's
    // `toolu_main` (still unmatched when c2 is correlated) and displaced p1.
    expect(byId(runs, 'c2')).toMatchObject({
      toolUseId: 'toolu_trap',
      parentAgentId: 'p1',
      spawnUuid: 'p1-a2',
    });
  });

  it('leaves legacy metadata unlinked instead of guessing a parent', async () => {
    const legacy = byId(await runsOf(`/api/sessions/${SESSION}`), 'legacy');
    expect(legacy.toolUseId).toBeUndefined();
    expect(legacy.spawnUuid).toBeUndefined();
    expect(legacy.parentAgentId).toBeUndefined();
  });

  it('keeps every nested run out of the main thread', async () => {
    const thread = JSON.stringify((await get(`/api/sessions/${SESSION}`)).json().thread);
    expect(thread).not.toContain('grandchild kaleidoscope report');
    expect(thread).not.toContain('depth-1 summary');
  });

  it('carries the whole descendant chain into a window around the spawn turn', async () => {
    const detail = (await get(`/api/sessions/${SESSION}?around=m-a1&radius=0`)).json();
    expect(detail.thread.map((t: { uuid: string }) => t.uuid)).toEqual(['m-a1']);
    // p1 anchors in the slice; c1/c2 anchor inside p1's thread and ride along.
    // The unlinked legacy run has no anchor at all and is dropped.
    expect(detail.subagents.map((r: Run) => r.agentId).sort()).toEqual(['c1', 'c2', 'p1']);
  });

  it('anchors a window on a depth-2 turn at the main-thread spawn of its chain', async () => {
    // MCP `get_session` anchors on search hits, which can be sidechain rows.
    const detail = (await get(`/api/sessions/${SESSION}?around=c1-a1&radius=0`)).json();
    expect(detail.window.anchorFound).toBe(true);
    expect(detail.thread.map((t: { uuid: string }) => t.uuid)).toEqual(['m-a1']);
    expect(detail.subagents.map((r: Run) => r.agentId).sort()).toEqual(['c1', 'c2', 'p1']);
  });

  it('drops nested runs from a window that excludes their ancestor', async () => {
    const detail = (await get(`/api/sessions/${SESSION}?around=m-u1&radius=0`)).json();
    expect(detail.thread.map((t: { uuid: string }) => t.uuid)).toEqual(['m-u1']);
    expect(detail.subagents).toEqual([]);
  });
});
