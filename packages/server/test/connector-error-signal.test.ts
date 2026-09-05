/**
 * Fitness function for the tool-error signal contract.
 *
 * `events.tool_error_count` is a three-valued column: a number when the source
 * format can tell a failed tool call from a successful one, NULL when it cannot
 * (so analytics reports "unavailable" instead of a fabricated 0). Two ways to
 * break that are invisible in a connector's own test: a connector that HAS a
 * signal but never sets `is_error` (reporting 0 errors forever), and a new
 * connector nobody classified at all.
 *
 * So this test walks the real registry: every connector id must be declared
 * either with or without a signal, and each TypeScript normalizer is run over a
 * minimal fixture holding ONE failing tool call — the declared ones must count
 * it, the undeclared ones must keep every row NULL. Claude Code derives the
 * column in SQL (`analytics-errors.integration.test.ts` covers it end to end),
 * so only its declaration is checked here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRow } from '../src/connectors/canonical.js';

const work = mkdtempSync(join(tmpdir(), 'claudescope-errsignal-'));
const codexDir = join(work, 'codex');
const piDir = join(work, 'pi');
const copilotDir = join(work, 'copilot');
const junieDir = join(work, 'junie');
const antigravityDir = join(work, 'antigravity');
const grokDir = join(work, 'grok');

process.env.CLAUDE_PROJECTS_DIR = join(work, 'claude-empty');
process.env.CODEX_SESSIONS_DIR = codexDir;
process.env.JUNIE_SESSIONS_DIR = junieDir;
process.env.PI_SESSIONS_DIR = piDir;
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = copilotDir;
process.env.ANTIGRAVITY_CLI_DIR = antigravityDir;
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-desktop-empty');
process.env.GROK_SESSIONS_DIR = grokDir;
process.env.CLAUDESCOPE_HOME = join(work, 'home');

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const at = (s: number) => `2026-08-01T09:00:${String(s).padStart(2, '0')}.000Z`;

/**
 * The canonical rows of one connector's minimal fixture. Populated in
 * `beforeAll` because the connector modules read their source dirs through the
 * env vars set above.
 */
const rowsByConnector = new Map<string, CanonicalRow[]>();

/** Codex: a shell call whose exec envelope reports a non-zero exit. */
async function codexRows(): Promise<CanonicalRow[]> {
  const dir = join(codexDir, '2026', '08', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-08-01T09-00-00-019f8888-aaaa-7bbb-8ccc-000000000001.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: at(0), payload: { id: 'codex-fail-1', cwd: '/tmp/errproj' } },
      { type: 'turn_context', timestamp: at(1), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: at(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build it' }] } },
      { type: 'response_item', timestamp: at(3), payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm run build"}', call_id: 'c1' } },
      { type: 'response_item', timestamp: at(4), payload: { type: 'function_call_output', call_id: 'c1', output: 'Chunk ID: a1\nWall time: 0.2 seconds\nProcess exited with code 1\nOutput:\nsh: vitest: command not found' } },
    ]),
  );
  const { parseRollout, toCanonicalRows } = await import('../src/connectors/codex/normalize.js');
  return toCanonicalRows(parseRollout(file)!, file);
}

/** pi: a `toolResult` record flagged `isError`. */
async function piRows(): Promise<CanonicalRow[]> {
  const dir = join(piDir, '--tmp-errproj--');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '2026-08-01T09-00-00-000Z_019f8888-aaaa-7bbb-8ccc-000000000002.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session', version: 3, id: 'pi-fail-1', timestamp: at(0), cwd: '/tmp/errproj' },
      { type: 'message', id: 'u1', parentId: null, timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'build it' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: at(2), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [{ type: 'toolCall', id: 'call_X|fc_x', name: 'bash', arguments: { command: 'npm run build' } }],
      } },
      { type: 'message', id: 'tr1', parentId: 'a1', timestamp: at(3), message: { role: 'toolResult', toolCallId: 'call_X|fc_x', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'sh: vitest: command not found' }] } },
    ]),
  );
  const { parsePiSession, toCanonicalRows } = await import('../src/connectors/pi/normalize.js');
  return toCanonicalRows(parsePiSession(file)!, file);
}

/** opencode: a `tool` part whose state reports `status: 'error'`. */
async function opencodeRows(): Promise<CanonicalRow[]> {
  const { toCanonicalRows } = await import('../src/connectors/opencode/normalize.js');
  const session = {
    id: 'ses_fail1',
    directory: '/tmp/errproj',
    title: 'Failing build',
    parentId: null,
    rootId: 'ses_fail1',
    messages: [
      { id: 'a1', data: JSON.stringify({ role: 'assistant', modelID: 'gpt-5.4-mini-fast', providerID: 'openai', time: { created: 2000 } }) },
    ],
    partsByMessage: new Map([
      ['a1', [
        JSON.stringify({
          type: 'tool', tool: 'bash', callID: 'call_b',
          state: { status: 'error', input: { command: 'npm run build' }, error: 'exit 1', output: 'sh: vitest: command not found' },
        }),
      ]],
    ]),
  };
  return toCanonicalRows(session, `${join(work, 'opencode.db')}#ses_fail1`);
}

/** Copilot: a `tool.execution_complete` with `success: false`. */
async function copilotRows(): Promise<CanonicalRow[]> {
  const dir = join(copilotDir, 'se');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'events.jsonl');
  let n = 0;
  const ev = (type: string, data: unknown) => ({ type, data, id: `e${n++}`, timestamp: at(n), parentId: null });
  writeFileSync(
    file,
    jsonl([
      ev('session.start', { sessionId: 'copilot-fail-1', context: { cwd: '/tmp/errproj', branch: 'main' } }),
      ev('session.model_change', { newModel: 'gpt-5-mini' }),
      ev('user.message', { content: 'build it' }),
      ev('assistant.message', { messageId: 'm1', model: 'gpt-5-mini', content: 'Building.', toolRequests: [
        { toolCallId: 'call-bash', name: 'bash', arguments: { command: 'npm run build' } },
      ] }),
      ev('tool.execution_start', { toolCallId: 'call-bash', toolName: 'bash', arguments: { command: 'npm run build' } }),
      ev('tool.execution_complete', { toolCallId: 'call-bash', success: false, result: { content: 'sh: vitest: command not found' } }),
    ]),
  );
  const { parseCopilotSession, toCanonicalRows } = await import('../src/connectors/copilot/normalize.js');
  return toCanonicalRows(parseCopilotSession(file)!, file);
}

/** Junie: a terminal step whose details read like a failure — no error signal. */
async function junieRows(): Promise<CanonicalRow[]> {
  const sessionId = 'session-260801-090000-err';
  const dir = join(junieDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const a2ux = (agentEvent: unknown, sec: number) => ({
    kind: 'SessionA2uxEvent',
    event: { state: 'IN_PROGRESS', agentEvent },
    timestampMs: Date.UTC(2026, 7, 1, 9, 0, sec),
  });
  writeFileSync(
    join(junieDir, 'index.jsonl'),
    jsonl([{ sessionId, createdAt: Date.UTC(2026, 7, 1, 9, 0, 0), updatedAt: Date.UTC(2026, 7, 1, 9, 0, 9), projectDir: '/tmp/errproj', taskName: 'Build it' }]),
  );
  const file = join(dir, 'events.jsonl');
  writeFileSync(
    file,
    jsonl([
      { kind: 'UserPromptEvent', prompt: 'build it' },
      { kind: 'SendToAgentEvent' },
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 'step-A', status: 'IN_PROGRESS', command: 'npm run build' }, 2),
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 'step-A', status: 'COMPLETED', details: 'sh: vitest: command not found' }, 3),
      a2ux({ kind: 'ResultBlockUpdatedEvent', stepId: 'step-R', cancelled: false, result: 'the build failed', changes: [] }, 4),
    ]),
  );
  const { parseSession, toCanonicalRows } = await import('../src/connectors/junie/normalize.js');
  return toCanonicalRows(parseSession(file)!, file);
}

/** Antigravity: a typed result record for a failed command — no error signal. */
async function antigravityRows(): Promise<CanonicalRow[]> {
  const conv = '55555555-5555-5555-5555-555555555555';
  const dir = join(antigravityDir, 'brain', conv, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript_full.jsonl');
  const step = (stepIndex: number, source: string, type: string, extra: Record<string, unknown> = {}) => ({
    step_index: stepIndex, source, type, status: 'DONE', created_at: at(stepIndex), ...extra,
  });
  writeFileSync(
    file,
    jsonl([
      step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>\nbuild it\n</USER_REQUEST>' }),
      step(1, 'MODEL', 'PLANNER_RESPONSE', {
        content: 'Reading the build script.',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: '/tmp/errproj/missing.ts', toolAction: 'View', toolSummary: 'View' } }],
      }),
      step(2, 'MODEL', 'VIEW_FILE', { content: 'Error: no such file or directory' }),
    ]),
  );
  const { parseAntigravitySession, toCanonicalRows } = await import('../src/connectors/antigravity/normalize.js');
  return toCanonicalRows(parseAntigravitySession(file), file);
}

/** Grok: a `tool_result` whose body is an error string — no error signal. */
async function grokRows(): Promise<CanonicalRow[]> {
  const dir = join(grokDir, '%2Ftmp%2Ferrproj', 'grok-fail-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({ info: { id: 'grok-fail-1', cwd: '/tmp/errproj' }, created_at: at(0), updated_at: at(9), current_model_id: 'grok-4.5', generated_title: 'Build it' }),
  );
  const file = join(dir, 'chat_history.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_query>\nbuild it\n</user_query>' }] },
      { type: 'assistant', content: 'Building.', model_id: 'grok-4.5', tool_calls: [
        { id: 'call-g0', name: 'run_terminal_command', arguments: JSON.stringify({ command: 'npm run build' }) },
      ] },
      { type: 'tool_result', tool_call_id: 'call-g0', content: 'sh: vitest: command not found' },
    ]),
  );
  const { parseGrokSession, toCanonicalRows } = await import('../src/connectors/grok/normalize.js');
  return toCanonicalRows(parseGrokSession(file)!, file);
}

/** Every connector whose canonical rows come from a TypeScript normalizer. */
const NORMALIZER_FIXTURES: Record<string, () => Promise<CanonicalRow[]>> = {
  codex: codexRows,
  pi: piRows,
  opencode: opencodeRows,
  copilot: copilotRows,
  junie: junieRows,
  antigravity: antigravityRows,
  grok: grokRows,
};

let registryIds: string[];
let withSignal: string[];
let withoutSignal: string[];
let hasToolErrorSignal: (id: string) => boolean;

beforeAll(async () => {
  const capabilities = await import('../src/data/agent-capabilities.js');
  const { connectors } = await import('../src/connectors/registry.js');
  registryIds = connectors.map((c) => c.id);
  withSignal = capabilities.connectorsWithToolErrorSignal();
  withoutSignal = capabilities.connectorsWithoutToolErrorSignal();
  hasToolErrorSignal = capabilities.hasToolErrorSignal;

  for (const [id, build] of Object.entries(NORMALIZER_FIXTURES)) {
    rowsByConnector.set(id, await build());
  }
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('tool-error signal declaration', () => {
  it('classifies every registered connector exactly once', () => {
    expect([...withSignal, ...withoutSignal].sort()).toEqual([...registryIds].sort());
    for (const id of withSignal) expect(hasToolErrorSignal(id)).toBe(true);
    for (const id of withoutSignal) expect(hasToolErrorSignal(id)).toBe(false);
  });

  it('declares a signal for Claude Code, whose column is derived in SQL', () => {
    // The only connector with no TypeScript normalizer — its projection is
    // covered by analytics-errors.integration.test.ts.
    expect(hasToolErrorSignal('claude-code')).toBe(true);
    expect(Object.keys(NORMALIZER_FIXTURES)).not.toContain('claude-code');
  });

  it('covers every TypeScript normalizer with a fixture', () => {
    const normalizerIds = registryIds.filter((id) => id !== 'claude-code');
    expect(Object.keys(NORMALIZER_FIXTURES).sort()).toEqual([...normalizerIds].sort());
  });
});

describe('connectors that declare a tool-error signal', () => {
  it.each(['codex', 'pi', 'opencode', 'copilot'])('counts a failed tool call (%s)', (id) => {
    expect(hasToolErrorSignal(id)).toBe(true);
    const rows = rowsByConnector.get(id)!;
    expect(rows.length).toBeGreaterThan(0);
    const failed = rows.filter((r) => (r.tool_error_count ?? 0) >= 1);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => r.tool_error_text !== null && r.tool_error_text !== '')).toBe(true);
  });
});

describe('connectors whose format records no tool-error signal', () => {
  it.each(['junie', 'antigravity', 'grok'])('leaves every row NULL (%s)', (id) => {
    expect(hasToolErrorSignal(id)).toBe(false);
    const rows = rowsByConnector.get(id)!;
    expect(rows.length).toBeGreaterThan(0);
    // NULL, never 0: "no errors" and "can't know" must stay distinguishable.
    expect(rows.every((r) => r.tool_error_count === null)).toBe(true);
    expect(rows.every((r) => r.tool_error_text === null)).toBe(true);
  });
});
