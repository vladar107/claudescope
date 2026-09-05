/**
 * Tool-count semantics integration tests.
 *
 * THE RULE under test: token/cost SUMs dedup by billed API call
 * (`usage_canonical`), but per-row COUNTS — `tool_use_count`, the
 * `tool_names`/`skill_names` unnest, `tool_error_count` — dedup fork copies ONLY
 * (`forked_from_session_id IS NULL`). Claude Code writes one JSONL row per
 * content block of an assistant message, all sharing `message.id` and repeating
 * the FULL usage; exactly one of those rows wins the usage election, and it is
 * usually NOT one of the rows carrying the tool_use blocks. Filtering tool
 * counts on `usage_canonical` therefore hides most real tool calls.
 *
 * The fixture is one Claude Code session written the REAL way (a text row plus
 * two tool_use rows under one `message.id`), a user row carrying the two
 * tool_results (one failed), and a second single-row response — then a full FORK
 * copy of that file under a second sessionId, every line carrying `forkedFrom`.
 * The copy must contribute nothing, exactly as it contributes no tokens.
 *
 * Built like `dedup.integration.test.ts`: a synthetic ~/.claude/projects tree is
 * indexed into a throwaway DuckDB, then exercised through Fastify `.inject()`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-toolcounts-'));
const projectsDir = join(work, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
// Isolate from every real agent home so this Claude-only suite stays deterministic.
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
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

const MODEL = 'claude-opus-4-8';
const CWD = '/tmp/toolcounts';
const MAIN = 'toolMain';
const FORK = 'toolFork';

/** The two billed calls, each written once per fixture session. */
const USAGE_1 = { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 };
const USAGE_2 = { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 };

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** One assistant line: a single content block, the message-level usage repeated. */
function asst(opts: {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  messageId: string;
  content: Record<string, unknown>;
  usage: Usage;
  forkedFrom?: { sessionId: string; messageUuid: string };
}): Record<string, unknown> {
  const line: Record<string, unknown> = {
    type: 'assistant',
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp,
    cwd: CWD,
    isSidechain: false,
    requestId: `req_${opts.uuid}`,
    message: {
      id: opts.messageId,
      role: 'assistant',
      model: MODEL,
      content: [opts.content],
      usage: {
        input_tokens: opts.usage.input,
        output_tokens: opts.usage.output,
        cache_read_input_tokens: opts.usage.cacheRead,
        cache_creation_input_tokens: opts.usage.cacheWrite,
      },
    },
  };
  if (opts.forkedFrom) line.forkedFrom = opts.forkedFrom;
  return line;
}

const userText = (uuid: string, parentUuid: string | null, sessionId: string, ts: string, text: string) => ({
  type: 'user',
  uuid,
  parentUuid,
  sessionId,
  timestamp: ts,
  cwd: CWD,
  isSidechain: false,
  message: { role: 'user', content: text },
});

/** The user turn carrying both tool_results — one of them failed. */
const userResults = (sessionId: string) => ({
  type: 'user',
  uuid: 'm-u2',
  parentUuid: 'm-a3',
  sessionId,
  timestamp: '2026-01-01T10:00:03.000Z',
  cwd: CWD,
  isSidechain: false,
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu_bash', content: 'command not found', is_error: true },
      { type: 'tool_result', tool_use_id: 'tu_read', content: 'file contents' },
    ],
  },
});

/**
 * One session's lines. `forkedFrom` (when given) is stamped on EVERY line, the
 * way Claude Code marks a forked copy of the whole history.
 */
function lines(sessionId: string, forkedFrom?: { sessionId: string; messageUuid: string }): unknown[] {
  const ff = forkedFrom ? { forkedFrom } : {};
  return [
    { type: 'ai-title', sessionId, aiTitle: `Session ${sessionId}` },
    { ...userText('m-u1', null, sessionId, '2026-01-01T10:00:00.000Z', 'run something'), ...ff },
    // ONE billed response (msg_1) written as THREE rows sharing message.id and
    // repeating the full usage: a text block, then the two tool_use blocks. The
    // uuid tiebreak makes the TEXT row canonical, so both tool calls sit on rows
    // that lose the usage election.
    asst({ uuid: 'm-a1', parentUuid: 'm-u1', sessionId, timestamp: '2026-01-01T10:00:01.000Z', messageId: 'msg_1', usage: USAGE_1, content: { type: 'text', text: 'on it' }, ...ff }),
    asst({ uuid: 'm-a2', parentUuid: 'm-u1', sessionId, timestamp: '2026-01-01T10:00:01.100Z', messageId: 'msg_1', usage: USAGE_1, content: { type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'ls' } }, ...ff }),
    asst({ uuid: 'm-a3', parentUuid: 'm-u1', sessionId, timestamp: '2026-01-01T10:00:01.200Z', messageId: 'msg_1', usage: USAGE_1, content: { type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/tmp/x' } }, ...ff }),
    { ...userResults(sessionId), ...ff },
    asst({ uuid: 'm-a4', parentUuid: 'm-u2', sessionId, timestamp: '2026-01-01T10:00:05.000Z', messageId: 'msg_2', usage: USAGE_2, content: { type: 'text', text: 'done' }, ...ff }),
  ];
}

function writeFixtures(): void {
  const proj = join(projectsDir, 'enc-toolcounts');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${MAIN}.jsonl`), jsonl(lines(MAIN)));
  // Fork: the same history copied under a new sessionId, every line marked.
  writeFileSync(
    join(proj, `${FORK}.jsonl`),
    jsonl(lines(FORK, { sessionId: MAIN, messageUuid: 'm-a4' })),
  );
}

const RANGE = '?from=2026-01-01T00:00:00.000Z&to=2026-01-01T23:59:59.999Z';

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

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();

describe('tool calls are counted per row excluding fork copies, never through the usage election', () => {
  it('/api/analytics/tools: each tool_use block counted once (Bash 1, Read 1)', async () => {
    const { rows } = await get('/api/analytics/tools');
    const claude = rows.filter((r: { agent: string }) => r.agent === 'claude-code');
    const byTool = new Map(claude.map((r: { tool: string; count: number }) => [r.tool, r.count]));
    expect(byTool.get('Bash')).toBe(1);
    expect(byTool.get('Read')).toBe(1);
    expect(claude.reduce((acc: number, r: { count: number }) => acc + r.count, 0)).toBe(2);
  });

  it('/api/analytics/errors: toolCalls 2, toolErrors 1, errorRate 0.5', async () => {
    const { rows } = await get('/api/analytics/errors');
    const claude = rows.find((r: { connectorId: string }) => r.connectorId === 'claude-code');
    expect(claude.toolCalls).toBe(2);
    expect(claude.toolErrors).toBe(1);
    expect(claude.errorRate).toBeCloseTo(0.5, 12);
  });

  it('/api/analytics/agents: toolCalls 2 against 2 deduped responses', async () => {
    const { rows } = await get('/api/analytics/agents');
    const claude = rows.find((r: { connectorId: string }) => r.connectorId === 'claude-code');
    expect(claude.toolCalls).toBe(2);
    // Responses stay on the usage election: two billed calls, not five rows.
    expect(claude.responses).toBe(2);
    expect(claude.toolCallsPerResponse).toBeCloseTo(1, 12);
  });

  it('/api/analytics/sessions: the original session reports both tool calls', async () => {
    const { rows } = await get(`/api/analytics/sessions${RANGE}`);
    const main = rows.find((r: { sessionId: string }) => r.sessionId === MAIN);
    expect(main.toolCallCount).toBe(2);
    expect(main.responses).toBe(2);
    expect(main.toolCallsPerResponse).toBeCloseTo(1, 12);
    // The fork's copied rows are excluded everywhere, so it has no canonical
    // response left and falls below the route's minResponses floor — the same
    // reason its token totals are zero. Its zero tool calls are asserted through
    // /api/sessions below, which has no such floor.
    expect(rows.some((r: { sessionId: string }) => r.sessionId === FORK)).toBe(false);
  });

  it('/api/sessions: tool calls attribute to the original, none to the fork copy', async () => {
    const sessions = await get('/api/sessions');
    const byId = new Map(sessions.map((s: { id: string }) => [s.id, s]));
    expect((byId.get(MAIN) as { toolCallCount: number }).toolCallCount).toBe(2);
    expect((byId.get(FORK) as { toolCallCount: number }).toolCallCount).toBe(0);
  });

  it('/api/analytics/digest: reliability and tool mix see the same 2 calls', async () => {
    const digest = await get(`/api/analytics/digest${RANGE}`);
    expect(digest.errors.toolCalls).toBe(2);
    expect(digest.errors.toolErrors).toBe(1);
    const byTool = new Map(
      digest.topTools.map((t: { key: string; count: number }) => [t.key, t.count]),
    );
    expect(byTool.get('Bash')).toBe(1);
    expect(byTool.get('Read')).toBe(1);
  });

  it('tokens still count once per billed message, unaffected by the row-level rule', async () => {
    const { totals } = await get('/api/analytics');
    expect(totals.inputTokens).toBe(USAGE_1.input + USAGE_2.input); // 300
    expect(totals.outputTokens).toBe(USAGE_1.output + USAGE_2.output); // 30
    expect(totals.cacheReadTokens).toBe(USAGE_1.cacheRead + USAGE_2.cacheRead); // 50
    expect(totals.messageCount).toBe(2);
  });
});
