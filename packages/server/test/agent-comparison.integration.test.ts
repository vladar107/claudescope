/**
 * Cross-agent comparison endpoint integration tests.
 *
 * Builds one index from three agents' synthetic sources (Claude Code, Copilot,
 * Antigravity — the three usage-granularity classes) and exercises
 * /api/analytics/agents. Focus on the bug-prone edges:
 *   - null-vs-0 semantics: Antigravity (no token data) must report null tokens/
 *     cost/ratios while its counts stay real; Copilot (session-level usage)
 *     must report real session totals but null per-response ratios;
 *   - a crashed Copilot session (no shutdown) still counts as a session while
 *     adding zero usage;
 *   - usage_canonical dedup: a multi-block split counts as ONE response;
 *   - the PR-linked ride-along (count + cost per PR session) and its scoping;
 *   - the project filter (slug id → project_cwd resolution).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentComparisonResponse, AgentComparisonRow } from '@claudescope/shared';

const work = mkdtempSync(join(tmpdir(), 'claudescope-agents-'));
const projectsDir = join(work, 'projects');
const copilotDir = join(work, 'copilot', 'session-state');
const antigravityDir = join(work, 'gemini', 'antigravity-cli');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = copilotDir;
process.env.ANTIGRAVITY_CLI_DIR = antigravityDir;
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-desktop-empty');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// --- Claude Code fixtures (per-response usage) ------------------------------

const CLAUDE_CWD = '/tmp/agents-xproj';
const MODEL = 'claude-opus-4-8';
const RATE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };
const costOf = (u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number =>
  (u.input * RATE.input + u.output * RATE.output + u.cacheWrite * RATE.cacheWrite + u.cacheRead * RATE.cacheRead) /
  1_000_000;
const USAGE = { input: 100, output: 50, cacheRead: 200, cacheWrite: 0 };

function asst(opts: {
  uuid: string;
  sessionId: string;
  timestamp: string;
  messageId: string;
  tools?: number;
  sidechain?: boolean;
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
    cwd: CLAUDE_CWD,
    isSidechain: opts.sidechain ?? false,
    message: {
      id: opts.messageId,
      role: 'assistant',
      model: MODEL,
      content,
      usage: {
        input_tokens: USAGE.input,
        output_tokens: USAGE.output,
        cache_read_input_tokens: USAGE.cacheRead,
        cache_creation_input_tokens: USAGE.cacheWrite,
      },
    },
  };
}
const user = (uuid: string, sessionId: string, ts: string) => ({
  type: 'user', uuid, parentUuid: null, sessionId, timestamp: ts, cwd: CLAUDE_CWD,
  isSidechain: false, message: { role: 'user', content: 'hi' },
});

function writeClaudeFixtures(): void {
  const proj = join(projectsDir, 'agents-xproj');
  mkdirSync(proj, { recursive: true });

  // withPr: a PR link, a multi-block split (m1 twice → ONE response), a normal
  // call, and a sidechain response — 3 deduped responses, has_sidechain TRUE.
  writeFileSync(join(proj, 'withPr.jsonl'), jsonl([
    { type: 'ai-title', sessionId: 'withPr', aiTitle: 'With PR' },
    { type: 'pr-link', sessionId: 'withPr', prNumber: 7, prRepository: 'me/repo', prUrl: 'https://example/pr/7' },
    user('w-u1', 'withPr', '2026-06-10T10:00:00.000Z'),
    asst({ uuid: 'w-a1', sessionId: 'withPr', timestamp: '2026-06-10T10:00:01.000Z', messageId: 'm1', tools: 2 }),
    asst({ uuid: 'w-a1b', sessionId: 'withPr', timestamp: '2026-06-10T10:00:01.300Z', messageId: 'm1' }),
    asst({ uuid: 'w-a2', sessionId: 'withPr', timestamp: '2026-06-10T10:00:02.000Z', messageId: 'm2' }),
    asst({ uuid: 'w-s1', sessionId: 'withPr', timestamp: '2026-06-10T10:00:03.000Z', messageId: 'm3', sidechain: true }),
  ]));

  // plain: one response, no PR, no sidechain.
  writeFileSync(join(proj, 'plain.jsonl'), jsonl([
    { type: 'ai-title', sessionId: 'plain', aiTitle: 'Plain' },
    user('p-u1', 'plain', '2026-06-11T10:00:00.000Z'),
    asst({ uuid: 'p-a1', sessionId: 'plain', timestamp: '2026-06-11T10:00:01.000Z', messageId: 'p1' }),
  ]));
}

// --- Copilot fixtures (session-level usage) ---------------------------------

let evtId = 0;
const cts = (s: number) => `2026-06-16T10:00:${String(s).padStart(2, '0')}.000Z`;
const cev = (type: string, data: unknown) => ({ type, data, id: `e${evtId++}`, timestamp: cts(evtId), parentId: null });

function writeCopilotSession(uuid: string, sessionId: string, withShutdown: boolean): void {
  const dir = join(copilotDir, uuid);
  mkdirSync(dir, { recursive: true });
  const events: unknown[] = [
    cev('session.start', {
      sessionId,
      copilotVersion: '1.0.62',
      context: { cwd: '/tmp/agents-cproj', gitRoot: '/tmp/agents-cproj', branch: 'main', repository: 'me/cproj', hostType: 'github' },
    }),
    cev('user.message', { content: 'do a thing' }),
    cev('assistant.message', { messageId: `${sessionId}-m1`, model: 'gpt-5-mini', content: 'Done.' }),
  ];
  if (withShutdown) {
    events.push(
      cev('session.shutdown', {
        tokenDetails: { input: { tokenCount: 100 }, cache_read: { tokenCount: 20 }, output: { tokenCount: 50 } },
      }),
    );
  }
  writeFileSync(join(dir, 'events.jsonl'), jsonl(events));
  writeFileSync(
    join(dir, 'workspace.yaml'),
    `id: ${uuid}\ncwd: /tmp/agents-cproj\ngit_root: /tmp/agents-cproj\nrepository: me/cproj\nbranch: main\nname: Copilot ${sessionId}\nuser_named: false\n`,
  );
}

// --- Antigravity fixtures (no token data) ------------------------------------

const AG = '44444444-4444-4444-4444-444444444444';
const agAt = (s: number): string => `2026-07-01T12:00:${String(s).padStart(2, '0')}Z`;
const agStep = (stepIndex: number, source: string, type: string, extra: Record<string, unknown> = {}) => ({
  step_index: stepIndex,
  source,
  type,
  status: 'DONE',
  created_at: agAt(stepIndex),
  ...extra,
});

function writeAntigravityFixtures(): void {
  const dir = join(antigravityDir, 'brain', AG, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'transcript_full.jsonl'), jsonl([
    agStep(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>\nlook around\n</USER_REQUEST>' }),
    agStep(1, 'MODEL', 'PLANNER_RESPONSE', {
      content: 'Listing the directory.',
      tool_calls: [{ name: 'list_dir', args: { DirectoryPath: '/tmp/agents-agproj', toolAction: 'List' } }],
    }),
    agStep(2, 'MODEL', 'LIST_DIRECTORY', { content: '{"name":"README.md"}' }),
    agStep(3, 'MODEL', 'PLANNER_RESPONSE', { content: 'All done.' }),
  ]));
  writeFileSync(
    join(antigravityDir, 'history.jsonl'),
    jsonl([{ display: 'look around', timestamp: 2, workspace: '/tmp/agents-agproj', conversationId: AG }]),
  );
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;
let claudeProjectId: string;
let copilotProjectId: string;

beforeAll(async () => {
  writeClaudeFixtures();
  writeCopilotSession('ca', 'copilot-a', true);
  writeCopilotSession('cb', 'copilot-b', false);
  writeAntigravityFixtures();
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');
  const { projectIdFromCwd } = await import('../src/data/project-id.js');
  ({ closeConnection } = await import('../src/db/duckdb.js'));
  claudeProjectId = projectIdFromCwd(CLAUDE_CWD);
  copilotProjectId = projectIdFromCwd('/tmp/agents-cproj');
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

const fetchAgents = async (query = ''): Promise<AgentComparisonResponse> =>
  (await app.inject({ method: 'GET', url: `/api/analytics/agents${query}` })).json();
const byAgent = (r: AgentComparisonResponse): Map<string, AgentComparisonRow> =>
  new Map(r.rows.map((row) => [row.connectorId, row]));

describe('GET /api/analytics/agents', () => {
  it('returns one row per agent with real counts for all of them', async () => {
    const m = byAgent(await fetchAgents());
    expect([...m.keys()].sort()).toEqual(['antigravity', 'claude-code', 'copilot']);
    expect(m.get('claude-code')!.sessions).toBe(2);
    expect(m.get('copilot')!.sessions).toBe(2);
    expect(m.get('antigravity')!.sessions).toBe(1);
    // Counts are real numbers for every granularity class.
    expect(m.get('antigravity')!.responses).toBe(2);
    expect(m.get('antigravity')!.toolCalls).toBe(1);
  });

  it('reports null (never 0) for Antigravity token/cost metrics', async () => {
    const ag = byAgent(await fetchAgents()).get('antigravity')!;
    expect(ag.usageGranularity).toBe('none');
    expect(ag.totalTokens).toBeNull();
    expect(ag.inputTokens).toBeNull();
    expect(ag.costUsd).toBeNull();
    expect(ag.costPerSession).toBeNull();
    expect(ag.costPerResponse).toBeNull();
    expect(ag.tokensPerResponse).toBeNull();
    expect(ag.cacheHitRatio).toBeNull();
    expect(ag.availabilityNote).toMatch(/no token counts/i);
    // No error signal in the format either — folded error columns stay null.
    expect(ag.toolErrors).toBeNull();
    expect(ag.errorRate).toBeNull();
    expect(ag.interrupts).toBeNull();
  });

  it('reports real session totals but null per-response ratios for Copilot', async () => {
    const cp = byAgent(await fetchAgents()).get('copilot')!;
    expect(cp.usageGranularity).toBe('session-level');
    // The clean-shutdown session carries 100 in + 20 cache-read + 50 out; the
    // crashed one adds nothing but still counts as a session.
    expect(cp.totalTokens).toBe(170);
    expect(cp.costUsd).toBeGreaterThan(0);
    expect(cp.costPerSession).toBeCloseTo(cp.costUsd! / 2, 12);
    expect(cp.cacheHitRatio).toBeCloseTo(20 / (20 + 0 + 100), 6);
    expect(cp.tokensPerResponse).toBeNull();
    expect(cp.costPerResponse).toBeNull();
  });

  it('dedups a multi-block split to ONE response and computes real ratios for Claude Code', async () => {
    const cc = byAgent(await fetchAgents()).get('claude-code')!;
    expect(cc.usageGranularity).toBe('per-response');
    // withPr: m1 (split over 2 rows) + m2 + sidechain m3 = 3; plain: 1.
    expect(cc.responses).toBe(4);
    expect(cc.costUsd).toBeCloseTo(costOf(USAGE) * 4, 12);
    expect(cc.costPerResponse).toBeCloseTo(costOf(USAGE), 12);
    expect(cc.tokensPerResponse).toBeCloseTo(350, 6);
    expect(cc.toolCallsPerResponse).toBeCloseTo(2 / 4, 6);
    // Only withPr spawned a sidechain → 1 of 2 sessions.
    expect(cc.subagentSessions).toBe(1);
    expect(cc.subagentShare).toBeCloseTo(0.5, 6);
    // Folded error/interrupt signals: Claude Code reports real numbers (the
    // fixtures carry no is_error results or interrupt markers → real zeros,
    // not n/a), while interrupts stay null for every other agent.
    expect(cc.toolErrors).toBe(0);
    expect(cc.interrupts).toBe(0);
    const cp = byAgent(await fetchAgents()).get('copilot')!;
    expect(cp.interrupts).toBeNull();
  });

  it('computes the PR-linked ride-along over the scope', async () => {
    const { prLinked } = await fetchAgents();
    expect(prLinked.sessions).toBe(1);
    // withPr's deduped cost: 3 canonical responses.
    expect(prLinked.costUsd).toBeCloseTo(costOf(USAGE) * 3, 12);
    expect(prLinked.costPerPrSession).toBeCloseTo(prLinked.costUsd, 12);
  });

  it('filters by project slug id', async () => {
    const claudeOnly = await fetchAgents(`?project=${encodeURIComponent(claudeProjectId)}`);
    expect(claudeOnly.rows.map((r) => r.connectorId)).toEqual(['claude-code']);
    expect(claudeOnly.prLinked.sessions).toBe(1);

    const copilotOnly = await fetchAgents(`?project=${encodeURIComponent(copilotProjectId)}`);
    expect(copilotOnly.rows.map((r) => r.connectorId)).toEqual(['copilot']);
    // No PR-linked sessions in this project → 0 count, null ratio (not 0).
    expect(copilotOnly.prLinked.sessions).toBe(0);
    expect(copilotOnly.prLinked.costPerPrSession).toBeNull();

    const none = await fetchAgents('?project=no-such-project');
    expect(none.rows).toEqual([]);
  });

  it('filters by session start date', async () => {
    // Only Antigravity's session starts on/after 2026-07-01.
    const m = byAgent(await fetchAgents('?from=2026-07-01T00:00:00.000Z'));
    expect([...m.keys()]).toEqual(['antigravity']);
    const empty = await fetchAgents('?from=2027-01-01T00:00:00.000Z');
    expect(empty.rows).toEqual([]);
    expect(empty.prLinked.sessions).toBe(0);
  });
});
