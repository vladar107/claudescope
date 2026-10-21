/**
 * End-to-end test for `GET /api/subagents`: a sandboxed `~/.claude/agents`
 * holding one user agent, indexed alongside a Claude Code session that spawns
 * it and the built-in `Explore` — plus a FORK copy of that whole session,
 * which must contribute no calls.
 *
 * This is the only place the Claude Code `subagent_names` projection (derived
 * in SQL, so unreachable from `connector-subagent-signal.test.ts`) meets the
 * live home-dir read and the usage join. The edges it pins down: a spawn of a
 * defined agent joins its definition, a built-in lands in `unlocated` rather
 * than being dropped, and fork copies are excluded exactly as they are from
 * every other per-row count.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AgentSubagents, SubagentsConnectorOverview, SubagentsResponse } from '@claudescope/shared';

// --- temp locations (decided before any server module is imported) ----------
const work = realpathSync(mkdtempSync(join(tmpdir(), 'claudescope-subagentsapi-')));
const claudeHome = join(work, 'claude');
const projectsDir = join(claudeHome, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
// Isolate from every real agent home so this Claude-only suite stays deterministic.
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty', 'sessions');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty', 'sessions');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty', 'sessions');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.OPENCODE_CONFIG_DIR = join(work, 'opencode-config-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty', 'sessions');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-desktop-empty');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty', 'sessions');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

const MODEL = 'claude-opus-4-8';
const CWD = '/tmp/subagentsapi';
const MAIN = 'subagentsMain';
const FORK = 'subagentsFork';

type Fork = { sessionId: string; messageUuid: string };

/** Timestamp of the last spawn of the defined agent — what `lastUsedAt` must come back as. */
const LAST_SPAWN_TS = '2026-01-01T10:00:05.000Z';

/** One assistant line: a single content block, the message-level usage repeated. */
function asst(opts: {
  uuid: string;
  parentUuid: string;
  sessionId: string;
  timestamp: string;
  messageId: string;
  content: Record<string, unknown>;
  forkedFrom?: Fork;
}): Record<string, unknown> {
  return {
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
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    ...(opts.forkedFrom ? { forkedFrom: opts.forkedFrom } : {}),
  };
}

const spawn = (id: string, subagentType: string) => ({
  type: 'tool_use',
  id,
  name: 'Agent',
  input: { description: `run ${subagentType}`, prompt: 'go', subagent_type: subagentType },
});

/** The session's lines; `forkedFrom` is stamped on EVERY line of a fork copy. */
function lines(sessionId: string, forkedFrom?: Fork): unknown[] {
  const ff = forkedFrom ? { forkedFrom } : {};
  return [
    { type: 'ai-title', sessionId, aiTitle: `Session ${sessionId}` },
    {
      type: 'user',
      uuid: 'm-u1',
      parentUuid: null,
      sessionId,
      timestamp: '2026-01-01T10:00:00.000Z',
      cwd: CWD,
      isSidechain: false,
      message: { role: 'user', content: 'delegate' },
      ...ff,
    },
    // A text row plus a spawn row sharing `message.id`: the spawn row loses
    // the usage election, so a count filtered on it would miss the spawn.
    asst({ uuid: 'm-a1', parentUuid: 'm-u1', sessionId, timestamp: '2026-01-01T10:00:01.000Z', messageId: 'msg_1', content: { type: 'text', text: 'on it' }, ...ff }),
    asst({ uuid: 'm-a2', parentUuid: 'm-u1', sessionId, timestamp: '2026-01-01T10:00:01.100Z', messageId: 'msg_1', content: spawn('tu_x1', 'Explore'), ...ff }),
    asst({ uuid: 'm-a3', parentUuid: 'm-a2', sessionId, timestamp: '2026-01-01T10:00:02.000Z', messageId: 'msg_2', content: spawn('tu_x2', 'code-reviewer'), ...ff }),
    asst({ uuid: 'm-a4', parentUuid: 'm-a3', sessionId, timestamp: LAST_SPAWN_TS, messageId: 'msg_3', content: spawn('tu_x3', 'code-reviewer'), ...ff }),
  ];
}

function writeFixtures(): void {
  const agents = join(claudeHome, 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    join(agents, 'code-reviewer.md'),
    '---\nname: code-reviewer\ndescription: Reviews diffs\nmodel: sonnet\n---\n\nReview the change.\n',
  );
  writeFileSync(join(agents, 'idle.md'), '---\nname: idle\ndescription: Never spawned\n---\n');

  const proj = join(projectsDir, 'enc-subagentsapi');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${MAIN}.jsonl`), jsonl(lines(MAIN)));
  writeFileSync(join(proj, `${FORK}.jsonl`), jsonl(lines(FORK, { sessionId: MAIN, messageUuid: 'm-a4' })));
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;
let claude: AgentSubagents;
let overview: SubagentsConnectorOverview;

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

  const body = (await app.inject({ method: 'GET', url: '/api/subagents' })).json() as SubagentsResponse;
  claude = body.agents.find((a) => a.connectorId === 'claude-code')!;
  overview = body.connectors.find((c) => c.connectorId === 'claude-code')!;
});

afterAll(async () => {
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('GET /api/subagents', () => {
  it('joins the spawns of a defined agent, fork copy excluded', () => {
    expect(claude.usageSignal).toBe(true);
    const byName = new Map(claude.subagents.map((s) => [s.name, s]));
    const reviewer = byName.get('code-reviewer')!;
    expect(reviewer).toMatchObject({ description: 'Reviews diffs', model: 'sonnet', origin: 'user' });
    expect(reviewer.usage).toEqual({ calls: 2, sessions: 1, lastUsedAt: LAST_SPAWN_TS });
    expect(byName.get('idle')!.usage).toBeUndefined();
  });

  it('reports a built-in as unlocated rather than dropping it', () => {
    expect(claude.unlocated).toEqual([
      { name: 'Explore', usage: { calls: 1, sessions: 1, lastUsedAt: '2026-01-01T10:00:01.100Z' } },
    ]);
  });

  it('rolls the same figures up into the landing card', () => {
    expect(overview).toMatchObject({ supported: true, installed: 2, used: 1, neverUsed: 1, unlocated: 1 });
  });
});
