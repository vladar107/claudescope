/**
 * /api/analytics/errors integration tests — the n/a contract and the interrupt
 * marker, per the repo test doctrine (the bug-prone edges, not happy-path glue):
 *
 *  1. NULL-vs-counted tool errors — Claude Code counts `is_error` tool_results
 *     (a real 0 stays 0); Junie's format carries no error signal, so its sums
 *     must surface as `toolErrors: null` ("can't know"), never 0.
 *  2. Interrupt marker — prefix-anchored: the genuine Claude Code interrupt
 *     message counts, an ordinary message QUOTING the marker mid-text does not.
 *     Interrupts are null (not 0) for every non-Claude agent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ErrorAnalyticsResponse } from '@claudescope/shared';
import { projectIdFromCwd } from '../src/data/project-id.js';

const work = mkdtempSync(join(tmpdir(), 'claudescope-errs-'));
const projectsDir = join(work, 'projects');
const junieDir = join(work, 'junie');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = junieDir;
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ts = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const CWD = '/tmp/errsproj';

function claudeLine(type: 'user' | 'assistant', uuid: string, parent: string | null, sec: number, message: unknown): unknown {
  return {
    type,
    uuid,
    parentUuid: parent,
    sessionId: 'errs-claude-1',
    timestamp: ts(sec),
    cwd: CWD,
    isSidechain: false,
    message,
  };
}

/** Claude session: 2 tool calls (1 errored), 1 genuine interrupt, 1 quote of the marker. */
function writeClaudeFixture(): void {
  const dir = join(projectsDir, '-tmp-errsproj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'errs-claude-1.jsonl'),
    jsonl([
      claudeLine('user', 'u0', null, 0, { role: 'user', content: 'run the tests' }),
      claudeLine('assistant', 'a1', 'u0', 1, {
        role: 'assistant',
        model: 'claude-opus-4-8',
        id: 'msg_a1',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      claudeLine('user', 'u2', 'a1', 2, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'FAIL' }],
      }),
      claudeLine('assistant', 'a3', 'u2', 3, {
        role: 'assistant',
        model: 'claude-opus-4-8',
        id: 'msg_a3',
        content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: `${CWD}/a.ts` } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      claudeLine('user', 'u4', 'a3', 4, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }],
      }),
      // A genuine interrupt: the marker IS the message text.
      claudeLine('user', 'u5', 'u4', 5, {
        role: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
      }),
      // An ordinary message merely QUOTING the marker — must NOT count.
      claudeLine('user', 'u6', 'u5', 6, {
        role: 'user',
        content: 'earlier we discussed the [Request interrupted by user] marker semantics',
      }),
    ]),
  );
}

const a2ux = (agentEvent: unknown, sec: number) => ({
  kind: 'SessionA2uxEvent',
  event: { state: 'IN_PROGRESS', agentEvent },
  timestampMs: Date.UTC(2026, 0, 1, 10, 0, sec),
});

/** Junie session: one tool step + one terminal step — tool calls with NO error signal. */
function writeJunieFixture(): void {
  const id = 'session-260101-100000-errs';
  const dir = join(junieDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(junieDir, 'index.jsonl'),
    jsonl([
      {
        sessionId: id,
        createdAt: Date.UTC(2026, 0, 1, 10, 0, 0),
        updatedAt: Date.UTC(2026, 0, 1, 10, 0, 9),
        projectDir: '/tmp/junie-errsproj',
        taskName: 'junie errors fixture',
      },
    ]),
  );
  writeFileSync(
    join(dir, 'events.jsonl'),
    jsonl([
      { kind: 'UserPromptEvent', prompt: 'poke around' },
      { kind: 'SendToAgentEvent' },
      a2ux({ kind: 'ToolBlockUpdatedEvent', stepId: 's1', text: 'Open a.txt', status: 'IN_PROGRESS' }, 1),
      a2ux(
        {
          kind: 'ViewFilesBlockUpdatedEvent',
          stepId: 's1',
          status: 'COMPLETED',
          files: [{ relativePath: 'a.txt', lineFrom: 1, lineTo: 2 }],
          details: 'looked',
        },
        2,
      ),
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 's2', status: 'IN_PROGRESS', command: 'ls' }, 3),
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 's2', status: 'COMPLETED', details: 'a.txt' }, 4),
    ]),
  );
}

let app: FastifyInstance | undefined;

beforeAll(async () => {
  writeClaudeFixture();
  writeJunieFixture();
  mkdirSync(join(work, 'codex-empty'), { recursive: true });

  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');

  app = Fastify();
  await registerRoutes(app);
  await reindex();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  const { closeConnection } = await import('../src/db/duckdb.js');
  await closeConnection();
  rmSync(work, { recursive: true, force: true });
});

async function fetchErrors(query = ''): Promise<ErrorAnalyticsResponse> {
  const res = await app!.inject({ method: 'GET', url: `/api/analytics/errors${query}` });
  expect(res.statusCode).toBe(200);
  return res.json() as ErrorAnalyticsResponse;
}

describe('/api/analytics/errors', () => {
  it('counts Claude Code is_error results and keeps a real error rate', async () => {
    const { rows } = await fetchErrors();
    const claude = rows.find((r) => r.connectorId === 'claude-code');
    expect(claude).toBeDefined();
    expect(claude!.toolCalls).toBe(2);
    expect(claude!.toolErrors).toBe(1);
    expect(claude!.errorRate).toBeCloseTo(0.5);
  });

  it('surfaces Junie tool errors as null (no signal), never 0', async () => {
    const { rows } = await fetchErrors();
    const junie = rows.find((r) => r.connectorId === 'junie');
    expect(junie).toBeDefined();
    expect(junie!.toolCalls).toBeGreaterThan(0);
    expect(junie!.toolErrors).toBeNull();
    expect(junie!.errorRate).toBeNull();
    expect(junie!.availabilityNote).toMatch(/no error signal/i);
  });

  it('counts the genuine interrupt but not a mid-text quote of the marker', async () => {
    const { rows } = await fetchErrors();
    const claude = rows.find((r) => r.connectorId === 'claude-code')!;
    expect(claude.interrupts).toBe(1);
    expect(claude.interruptsPerSession).toBeCloseTo(1);
    const junie = rows.find((r) => r.connectorId === 'junie')!;
    expect(junie.interrupts).toBeNull();
    expect(junie.interruptsPerSession).toBeNull();
  });

  it('scopes by project slug', async () => {
    const { rows } = await fetchErrors(`?project=${projectIdFromCwd(CWD)}`);
    expect(rows.map((r) => r.connectorId)).toEqual(['claude-code']);
  });
});
