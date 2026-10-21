/**
 * Fitness function for the subagent-invocation signal contract.
 *
 * `events.subagent_names` only carries a name when the source format records
 * which agent a spawn delegates to — mapped onto a canonical `Task`/`Agent`
 * call's `input.subagent_type` (or, for pi's batch `subagent` calls, read in its
 * normalizer). Where it does not, the Subagents tab must report a definition's
 * usage as ABSENT rather than the 0 an empty column would produce. Two ways to
 * break that are invisible in a connector's own test: a connector DECLARED to
 * have the signal whose normalizer never names the agent (every subagent reads
 * "never used" forever), and a connector NOT declared whose normalizer quietly
 * emits a typed `Task` (usage fabricated for an agent that cannot report it).
 *
 * So this test walks the real registry: every connector id must be declared
 * either with or without the signal, and each TypeScript normalizer is run over
 * a minimal fixture holding ONE spawn in that agent's own shape. The declared
 * ones must name the agent; any undeclared connector must leave
 * `subagent_names` empty on every row. Claude Code derives the column in SQL
 * (`tool-names.integration.test.ts` covers it end to end), so only its
 * declaration is checked here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRow } from '../src/connectors/canonical.js';

const work = mkdtempSync(join(tmpdir(), 'claudescope-subagentsignal-'));
const codexDir = join(work, 'codex');
const piDir = join(work, 'pi');
const copilotDir = join(work, 'copilot');
const junieDir = join(work, 'junie');
const antigravityDir = join(work, 'antigravity');
const grokDir = join(work, 'grok');

// Every agent source points into the throwaway tree, so nothing here can read
// (let alone write) a real agent home.
process.env.CLAUDE_PROJECTS_DIR = join(work, 'claude-empty');
process.env.CODEX_SESSIONS_DIR = codexDir;
process.env.JUNIE_SESSIONS_DIR = junieDir;
process.env.PI_SESSIONS_DIR = piDir;
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.OPENCODE_CONFIG_DIR = join(work, 'opencode-config-empty');
process.env.COPILOT_SESSIONS_DIR = copilotDir;
process.env.ANTIGRAVITY_CLI_DIR = antigravityDir;
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-desktop-empty');
process.env.GROK_SESSIONS_DIR = grokDir;
process.env.CLAUDESCOPE_HOME = join(work, 'home');

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const at = (s: number) => `2026-08-01T09:00:${String(s).padStart(2, '0')}.000Z`;

/** The subagent every fixture spawns, however its agent happens to record it. */
const AGENT = 'scout';

/** Grok: `spawn_subagent` → `Task`; the type comes from the parent's meta.json, matched by description. */
async function grokRows(): Promise<CanonicalRow[]> {
  const dir = join(grokDir, '%2Ftmp%2Fsubproj', 'grok-sub-1');
  mkdirSync(join(dir, 'subagents', 'grok-sub-child'), { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({ info: { id: 'grok-sub-1', cwd: '/tmp/subproj' }, created_at: at(0), updated_at: at(9), current_model_id: 'grok-4.5', generated_title: 'Spawn a subagent' }),
  );
  writeFileSync(
    join(dir, 'subagents', 'grok-sub-child', 'meta.json'),
    JSON.stringify({ subagent_id: 'grok-sub-child', parent_session_id: 'grok-sub-1', child_session_id: 'grok-sub-child', subagent_type: AGENT, description: 'Map the caves', prompt: 'Map the caves.' }),
  );
  const file = join(dir, 'chat_history.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_query>\nmap the caves\n</user_query>' }] },
      { type: 'assistant', content: 'Spawning.', model_id: 'grok-4.5', tool_calls: [
        { id: 'call-g0', name: 'spawn_subagent', arguments: JSON.stringify({ description: 'Map the caves', prompt: 'Map the caves.' }) },
      ] },
      { type: 'tool_result', tool_call_id: 'call-g0', content: 'subagent_id: grok-sub-child\nstatus: started' },
    ]),
  );
  const { parseGrokSession, toCanonicalRows } = await import('../src/connectors/grok/normalize.js');
  return toCanonicalRows(parseGrokSession(file)!, file);
}

/** Codex: `spawn_agent` → `Task`, its `agent_type` argument the subagent_type. */
async function codexRows(): Promise<CanonicalRow[]> {
  const dir = join(codexDir, '2026', '08', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-08-01T09-00-00-019f9999-aaaa-7bbb-8ccc-000000000011.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: at(0), payload: { id: 'codex-sub-1', cwd: '/tmp/subproj' } },
      { type: 'turn_context', timestamp: at(1), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: at(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'map the caves' }] } },
      { type: 'response_item', timestamp: at(3), payload: { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: AGENT, message: 'Map the caves.' }), call_id: 'c1' } },
      { type: 'response_item', timestamp: at(4), payload: { type: 'function_call_output', call_id: 'c1', output: '{"agent_id":"019f9999-aaaa-7bbb-8ccc-0000000000ff"}' } },
    ]),
  );
  const { parseRollout, toCanonicalRows } = await import('../src/connectors/codex/normalize.js');
  return toCanonicalRows(parseRollout(file)!, file);
}

/** One pi session whose single assistant turn makes `subagent` call(s) with these arguments. */
async function piSession(name: string, calls: Record<string, unknown>[]): Promise<CanonicalRow[]> {
  const dir = join(piDir, '--tmp-subproj--');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-08-01T09-00-00-000Z_${name}.jsonl`);
  writeFileSync(
    file,
    jsonl([
      { type: 'session', version: 3, id: name, timestamp: at(0), cwd: '/tmp/subproj' },
      { type: 'message', id: 'u1', parentId: null, timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'map the caves' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: at(2), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: calls.map((args, i) => ({ type: 'toolCall', id: `call_${i}|fc_${i}`, name: 'subagent', arguments: args })),
      } },
    ]),
  );
  const { parsePiSession, toCanonicalRows } = await import('../src/connectors/pi/normalize.js');
  return toCanonicalRows(parsePiSession(file)!, file);
}

/** pi: the single `{agent, task}` form of its `subagent` tool → `Task`. */
const piRows = (): Promise<CanonicalRow[]> => piSession('pi-sub-1', [{ agent: AGENT, task: 'Map the caves.' }]);

/** opencode: one `task` part with these spawn inputs. */
async function opencodeSession(id: string, input: Record<string, unknown>): Promise<CanonicalRow[]> {
  const { toCanonicalRows } = await import('../src/connectors/opencode/normalize.js');
  const session = {
    id,
    directory: '/tmp/subproj',
    title: 'Spawn a subagent',
    parentId: null,
    rootId: id,
    messages: [
      { id: 'a1', data: JSON.stringify({ role: 'assistant', modelID: 'gpt-5.4-mini-fast', providerID: 'openai', time: { created: 2000 } }) },
    ],
    partsByMessage: new Map([
      ['a1', [
        JSON.stringify({
          type: 'tool', tool: 'task', callID: 'call_t',
          state: { status: 'completed', input: { description: 'Map the caves', prompt: 'Map the caves.', ...input }, output: 'mapped' },
        }),
      ]],
    ]),
  };
  return toCanonicalRows(session, `${join(work, 'opencode.db')}#${id}`);
}

/** opencode: its `task` tool → `Task`, `subagent_type` naming the agent. */
const opencodeRows = (): Promise<CanonicalRow[]> => opencodeSession('ses_sub1', { subagent_type: AGENT });

/** Copilot: a `task` call becomes `Task` only for a linked run; `subagent.started` names the agent. */
async function copilotRows(): Promise<CanonicalRow[]> {
  const dir = join(copilotDir, 'sub');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'events.jsonl');
  let n = 0;
  const ev = (type: string, data: unknown) => ({ type, data, id: `e${n++}`, timestamp: at(n), parentId: null });
  const sub = (e: Record<string, unknown>) => ({ ...e, agentId: 'call-task' });
  writeFileSync(
    file,
    jsonl([
      ev('session.start', { sessionId: 'copilot-sub-1', context: { cwd: '/tmp/subproj', branch: 'main' } }),
      ev('session.model_change', { newModel: 'gpt-5-mini' }),
      ev('user.message', { content: 'map the caves' }),
      ev('assistant.message', { messageId: 'm1', model: 'gpt-5-mini', content: 'Delegating.', toolRequests: [
        { toolCallId: 'call-task', name: 'task', arguments: { description: 'Map the caves', prompt: 'Map the caves.' } },
      ] }),
      sub(ev('subagent.started', { toolCallId: 'call-task', agentName: AGENT, agentDisplayName: 'Scout', model: 'gpt-5-mini' })),
      sub(ev('assistant.message', { model: 'gpt-5-mini', content: 'Mapped.' })),
      sub(ev('subagent.completed', { toolCallId: 'call-task', agentName: AGENT })),
      ev('tool.execution_complete', { toolCallId: 'call-task', success: true, result: { content: 'Mapped.' } }),
    ]),
  );
  const { parseCopilotSession, toCanonicalRows } = await import('../src/connectors/copilot/normalize.js');
  return toCanonicalRows(parseCopilotSession(file)!, file);
}

/**
 * Junie: delegation is a plain `junie …` terminal command — its `spawn_subagent`
 * never reaches events.jsonl, so nothing may name an agent.
 */
async function junieRows(): Promise<CanonicalRow[]> {
  const sessionId = 'session-260801-090000-subagent';
  const dir = join(junieDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const a2ux = (agentEvent: unknown, sec: number) => ({
    kind: 'SessionA2uxEvent',
    event: { state: 'IN_PROGRESS', agentEvent },
    timestampMs: Date.UTC(2026, 7, 1, 9, 0, sec),
  });
  writeFileSync(
    join(junieDir, 'index.jsonl'),
    jsonl([{ sessionId, createdAt: Date.UTC(2026, 7, 1, 9, 0, 0), updatedAt: Date.UTC(2026, 7, 1, 9, 0, 9), projectDir: '/tmp/subproj', taskName: 'Delegate' }]),
  );
  const file = join(dir, 'events.jsonl');
  writeFileSync(
    file,
    jsonl([
      { kind: 'UserPromptEvent', prompt: 'map the caves' },
      { kind: 'SendToAgentEvent' },
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 'step-A', status: 'IN_PROGRESS', command: `junie --agent ${AGENT} "Map the caves."` }, 1),
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 'step-A', status: 'COMPLETED', details: 'mapped' }, 2),
      a2ux({ kind: 'ResultBlockUpdatedEvent', stepId: 'step-R', cancelled: false, result: 'mapped', changes: [] }, 3),
    ]),
  );
  const { parseSession, toCanonicalRows } = await import('../src/connectors/junie/normalize.js');
  return toCanonicalRows(parseSession(file)!, file);
}

/** Antigravity: `invoke_subagent` fans `Subagents[]` out to one `Task` per entry, `TypeName` the type. */
async function antigravitySession(conv: string, typeNames: string[]): Promise<CanonicalRow[]> {
  const dir = join(antigravityDir, 'brain', conv, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript_full.jsonl');
  const step = (stepIndex: number, source: string, type: string, extra: Record<string, unknown> = {}) => ({
    step_index: stepIndex, source, type, status: 'DONE', created_at: at(stepIndex), ...extra,
  });
  writeFileSync(
    file,
    jsonl([
      step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>\nmap the caves\n</USER_REQUEST>' }),
      step(1, 'MODEL', 'PLANNER_RESPONSE', {
        content: 'Delegating.',
        tool_calls: [{ name: 'invoke_subagent', args: {
          Subagents: typeNames.map((t) => ({ Prompt: `Map the caves as ${t}.`, Role: 'Explorer', TypeName: t, Workspace: 'inherit' })),
          toolAction: 'Invoke', toolSummary: 'Invoke',
        } }],
      }),
    ]),
  );
  const { parseAntigravitySession, toCanonicalRows } = await import('../src/connectors/antigravity/normalize.js');
  return toCanonicalRows(parseAntigravitySession(file), file);
}

const antigravityRows = (): Promise<CanonicalRow[]> =>
  antigravitySession('77777777-7777-7777-7777-777777777777', [AGENT]);

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

const rowsByConnector = new Map<string, CanonicalRow[]>();
let registryIds: string[];
let withSignal: string[];
let withoutSignal: string[];
let hasSubagentInvocationSignal: (id: string) => boolean;

beforeAll(async () => {
  const capabilities = await import('../src/data/agent-capabilities.js');
  const { connectors } = await import('../src/connectors/registry.js');
  registryIds = connectors.map((c) => c.id);
  withSignal = capabilities.connectorsWithSubagentInvocationSignal();
  withoutSignal = capabilities.connectorsWithoutSubagentInvocationSignal();
  hasSubagentInvocationSignal = capabilities.hasSubagentInvocationSignal;

  for (const [id, build] of Object.entries(NORMALIZER_FIXTURES)) {
    rowsByConnector.set(id, await build());
  }
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('subagent-invocation signal declaration', () => {
  it('classifies every registered connector exactly once', () => {
    expect([...withSignal, ...withoutSignal].sort()).toEqual([...registryIds].sort());
    expect(withSignal.filter((id) => withoutSignal.includes(id))).toEqual([]);
    for (const id of withSignal) expect(hasSubagentInvocationSignal(id)).toBe(true);
    for (const id of withoutSignal) expect(hasSubagentInvocationSignal(id)).toBe(false);
  });

  it('declares a signal for Claude Code, whose column is derived in SQL', () => {
    expect(hasSubagentInvocationSignal('claude-code')).toBe(true);
    expect(Object.keys(NORMALIZER_FIXTURES)).not.toContain('claude-code');
  });

  it('covers every TypeScript normalizer with a fixture', () => {
    const normalizerIds = registryIds.filter((id) => id !== 'claude-code');
    expect(Object.keys(NORMALIZER_FIXTURES).sort()).toEqual([...normalizerIds].sort());
  });
});

describe('connectors that declare a subagent-invocation signal', () => {
  it('names the spawned agent on exactly one row of each one-spawn fixture', () => {
    const declared = Object.keys(NORMALIZER_FIXTURES).filter((id) => withSignal.includes(id));
    expect(declared.length).toBeGreaterThan(0);
    for (const id of declared) {
      const named = rowsByConnector.get(id)!.filter((r) => r.subagent_names !== '');
      expect(named.map((r) => r.subagent_names), id).toEqual([AGENT]);
      expect(named[0]!.tool_names.split(','), id).toContain('Task');
    }
  });

  it('counts each task of a pi batch call — tasks[] and chain[] alike, no dedupe', async () => {
    const rows = await piSession('pi-sub-batch', [
      { tasks: [{ agent: AGENT, task: 'North passage.' }, { agent: 'planner', task: 'Plan.' }, { agent: AGENT, task: 'South passage.' }] },
      { chain: [{ agent: 'reviewer', task: 'Review the map.' }] },
    ]);
    const named = rows.filter((r) => r.subagent_names !== '');
    expect(named.map((r) => r.subagent_names)).toEqual([`${AGENT},planner,${AGENT},reviewer`]);
    // The batch forms stay raw calls: nothing was invented as a Task block.
    expect(named[0]!.tool_names).toBe('subagent,subagent');
  });

  it('reads the agent from newer opencode `agent` input, falling back to subagent_type', async () => {
    const rows = await opencodeSession('ses_sub2', { agent: AGENT });
    expect(rows.filter((r) => r.subagent_names !== '').map((r) => r.subagent_names)).toEqual([AGENT]);
  });

  it('names every entry of an Antigravity invoke_subagent fan-out', async () => {
    const rows = await antigravitySession('88888888-8888-8888-8888-888888888888', [AGENT, 'research']);
    expect(rows.filter((r) => r.subagent_names !== '').map((r) => r.subagent_names)).toEqual([`${AGENT},research`]);
  });
});

describe('connectors whose format records no subagent invocation', () => {
  it('leave subagent_names empty on every row', () => {
    expect(withoutSignal).toContain('junie');
    for (const id of withoutSignal) {
      expect(hasSubagentInvocationSignal(id)).toBe(false);
      const rows = rowsByConnector.get(id)!;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.subagent_names === '')).toBe(true);
    }
  });
});
