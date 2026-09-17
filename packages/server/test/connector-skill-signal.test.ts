/**
 * Fitness function for the skill-invocation signal contract.
 *
 * `events.skill_names` only carries a name when the source format records a
 * skill load — as a canonical `Skill` tool call, or as a read of the skill's
 * `…/skills/<dir>/SKILL.md`. Where it does neither, the Skills page must report
 * a skill's usage as ABSENT rather than the 0 an empty column would otherwise
 * produce. Two ways to break that are invisible in a
 * connector's own test: a connector DECLARED to have the signal whose
 * normalizer never names a skill (every skill reads "never used" forever),
 * and a connector NOT declared whose normalizer quietly maps some tool to
 * `Skill` (usage fabricated for an agent that cannot report it).
 *
 * So this test walks the real registry: every connector id must be declared
 * either with or without the signal, and each TypeScript normalizer is run over
 * a minimal fixture holding ONE skill load in that agent's own shape — a native
 * call (Grok, opencode, Junie) or a read of `…/skills/<name>/SKILL.md` (Codex,
 * pi, Copilot, Antigravity). The declared ones must name the skill; a native
 * call must also surface as a canonical `Skill` block, while a file read must
 * NOT (that would invent a call the agent never made). Any undeclared connector
 * must leave `skill_names` empty on every row. Claude Code derives the column
 * in SQL (`skills.integration.test.ts` covers it end to end), so only its
 * declaration is checked here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRow } from '../src/connectors/canonical.js';

const work = mkdtempSync(join(tmpdir(), 'claudescope-skillsignal-'));
const codexDir = join(work, 'codex');
const piDir = join(work, 'pi');
const copilotDir = join(work, 'copilot');
const junieDir = join(work, 'junie');
const antigravityDir = join(work, 'antigravity');
const grokDir = join(work, 'grok');

// Every agent source — and every skills dir — points into the throwaway tree,
// so nothing here can read (let alone write) a real agent home.
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

/** The skill every fixture "invokes", however its agent happens to record it. */
const SKILL = 'now';

/**
 * The canonical rows of one connector's minimal fixture. Populated in
 * `beforeAll` because the connector modules read their source dirs through the
 * env vars set above.
 */
const rowsByConnector = new Map<string, CanonicalRow[]>();

/** Grok: its `skill` tool → canonical `Skill`, so the name lands in the column. */
async function grokRows(): Promise<CanonicalRow[]> {
  const dir = join(grokDir, '%2Ftmp%2Fskillproj', 'grok-skill-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({ info: { id: 'grok-skill-1', cwd: '/tmp/skillproj' }, created_at: at(0), updated_at: at(9), current_model_id: 'grok-4.5', generated_title: 'Use a skill' }),
  );
  const file = join(dir, 'chat_history.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_query>\nwhat time is it\n</user_query>' }] },
      { type: 'assistant', content: 'Checking.', model_id: 'grok-4.5', tool_calls: [
        { id: 'call-g0', name: 'skill', arguments: JSON.stringify({ skill: SKILL }) },
      ] },
      { type: 'tool_result', tool_call_id: 'call-g0', content: 'skill loaded' },
    ]),
  );
  const { parseGrokSession, toCanonicalRows } = await import('../src/connectors/grok/normalize.js');
  return toCanonicalRows(parseGrokSession(file)!, file);
}

/** Codex: a skill arrives as a `$mention` in the prompt — no tool call at all. */
async function codexRows(): Promise<CanonicalRow[]> {
  const dir = join(codexDir, '2026', '08', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-08-01T09-00-00-019f9999-aaaa-7bbb-8ccc-000000000001.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: at(0), payload: { id: 'codex-skill-1', cwd: '/tmp/skillproj' } },
      { type: 'turn_context', timestamp: at(1), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: at(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `$${SKILL} what time is it` }] } },
      { type: 'response_item', timestamp: at(3), payload: { type: 'function_call', name: 'read_file', arguments: `{"path":"/root/.codex/skills/${SKILL}/SKILL.md"}`, call_id: 'c1' } },
      { type: 'response_item', timestamp: at(4), payload: { type: 'function_call_output', call_id: 'c1', output: '# now' } },
    ]),
  );
  const { parseRollout, toCanonicalRows } = await import('../src/connectors/codex/normalize.js');
  return toCanonicalRows(parseRollout(file)!, file);
}

/** pi: loads a skill by reading its SKILL.md — an ordinary `read` call names it. */
async function piRows(): Promise<CanonicalRow[]> {
  const dir = join(piDir, '--tmp-skillproj--');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '2026-08-01T09-00-00-000Z_019f9999-aaaa-7bbb-8ccc-000000000002.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session', version: 3, id: 'pi-skill-1', timestamp: at(0), cwd: '/tmp/skillproj' },
      { type: 'message', id: 'u1', parentId: null, timestamp: at(1), message: { role: 'user', content: [{ type: 'text', text: 'what time is it' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: at(2), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [{ type: 'toolCall', id: 'call_S|fc_s', name: 'read', arguments: { path: `/root/.pi/agent/skills/${SKILL}/SKILL.md` } }],
      } },
      { type: 'message', id: 'tr1', parentId: 'a1', timestamp: at(3), message: { role: 'toolResult', toolCallId: 'call_S|fc_s', toolName: 'read', isError: false, content: [{ type: 'text', text: '# now' }] } },
    ]),
  );
  const { parsePiSession, toCanonicalRows } = await import('../src/connectors/pi/normalize.js');
  return toCanonicalRows(parsePiSession(file)!, file);
}

/** opencode: its native `skill` tool (`{ name }`) is the load. */
async function opencodeRows(): Promise<CanonicalRow[]> {
  const { toCanonicalRows } = await import('../src/connectors/opencode/normalize.js');
  const session = {
    id: 'ses_skill1',
    directory: '/tmp/skillproj',
    title: 'Use a skill',
    parentId: null,
    rootId: 'ses_skill1',
    messages: [
      { id: 'a1', data: JSON.stringify({ role: 'assistant', modelID: 'gpt-5.4-mini-fast', providerID: 'openai', time: { created: 2000 } }) },
    ],
    partsByMessage: new Map([
      ['a1', [
        JSON.stringify({
          type: 'tool', tool: 'skill', callID: 'call_s',
          state: { status: 'completed', input: { name: SKILL }, output: '# now' },
        }),
      ]],
    ]),
  };
  return toCanonicalRows(session, `${join(work, 'opencode.db')}#ses_skill1`);
}

/** Copilot: loads a skill by viewing its SKILL.md — an ordinary `view` call names it. */
async function copilotRows(): Promise<CanonicalRow[]> {
  const dir = join(copilotDir, 'se');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'events.jsonl');
  let n = 0;
  const ev = (type: string, data: unknown) => ({ type, data, id: `e${n++}`, timestamp: at(n), parentId: null });
  writeFileSync(
    file,
    jsonl([
      ev('session.start', { sessionId: 'copilot-skill-1', context: { cwd: '/tmp/skillproj', branch: 'main' } }),
      ev('session.model_change', { newModel: 'gpt-5-mini' }),
      ev('user.message', { content: 'what time is it' }),
      ev('assistant.message', { messageId: 'm1', model: 'gpt-5-mini', content: 'Checking.', toolRequests: [
        { toolCallId: 'call-view', name: 'view', arguments: { path: `/root/.copilot/skills/${SKILL}/SKILL.md` } },
      ] }),
      ev('tool.execution_start', { toolCallId: 'call-view', toolName: 'view', arguments: { path: `/root/.copilot/skills/${SKILL}/SKILL.md` } }),
      ev('tool.execution_complete', { toolCallId: 'call-view', success: true, result: { content: '# now' } }),
    ]),
  );
  const { parseCopilotSession, toCanonicalRows } = await import('../src/connectors/copilot/normalize.js');
  return toCanonicalRows(parseCopilotSession(file)!, file);
}

/** Junie: a `toolType: 'Skill'` ToolBlockUpdatedEvent carries the skill structurally. */
async function junieRows(): Promise<CanonicalRow[]> {
  const sessionId = 'session-260801-090000-skill';
  const dir = join(junieDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const a2ux = (agentEvent: unknown, sec: number) => ({
    kind: 'SessionA2uxEvent',
    event: { state: 'IN_PROGRESS', agentEvent },
    timestampMs: Date.UTC(2026, 7, 1, 9, 0, sec),
  });
  writeFileSync(
    join(junieDir, 'index.jsonl'),
    jsonl([{ sessionId, createdAt: Date.UTC(2026, 7, 1, 9, 0, 0), updatedAt: Date.UTC(2026, 7, 1, 9, 0, 9), projectDir: '/tmp/skillproj', taskName: 'Use a skill' }]),
  );
  const file = join(dir, 'events.jsonl');
  writeFileSync(
    file,
    jsonl([
      { kind: 'UserPromptEvent', prompt: 'what time is it' },
      { kind: 'SendToAgentEvent' },
      a2ux({ kind: 'ToolBlockUpdatedEvent', stepId: 'step-S', status: 'COMPLETED', text: 'Read skill', details: SKILL, toolType: 'Skill', skillName: SKILL, skillPath: `/root/.junie/skills/${SKILL}/SKILL.md` }, 1),
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 'step-A', status: 'IN_PROGRESS', command: 'date' }, 2),
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 'step-A', status: 'COMPLETED', details: 'Sat Aug  1 09:00:00 UTC 2026' }, 3),
      a2ux({ kind: 'ResultBlockUpdatedEvent', stepId: 'step-R', cancelled: false, result: 'it is 09:00', changes: [] }, 4),
    ]),
  );
  const { parseSession, toCanonicalRows } = await import('../src/connectors/junie/normalize.js');
  return toCanonicalRows(parseSession(file)!, file);
}

/** Antigravity: loads a skill by viewing its SKILL.md — the `view_file` call names it. */
async function antigravityRows(): Promise<CanonicalRow[]> {
  const conv = '66666666-6666-6666-6666-666666666666';
  const dir = join(antigravityDir, 'brain', conv, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript_full.jsonl');
  const step = (stepIndex: number, source: string, type: string, extra: Record<string, unknown> = {}) => ({
    step_index: stepIndex, source, type, status: 'DONE', created_at: at(stepIndex), ...extra,
  });
  writeFileSync(
    file,
    jsonl([
      step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>\nwhat time is it\n</USER_REQUEST>' }),
      step(1, 'MODEL', 'PLANNER_RESPONSE', {
        content: 'Reading the skill.',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: `/root/.gemini/antigravity/skills/${SKILL}/SKILL.md`, toolAction: 'View', toolSummary: 'View' } }],
      }),
      step(2, 'MODEL', 'VIEW_FILE', { content: '# now' }),
    ]),
  );
  const { parseAntigravitySession, toCanonicalRows } = await import('../src/connectors/antigravity/normalize.js');
  return toCanonicalRows(parseAntigravitySession(file), file);
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
let hasSkillInvocationSignal: (id: string) => boolean;

beforeAll(async () => {
  const capabilities = await import('../src/data/agent-capabilities.js');
  const { connectors } = await import('../src/connectors/registry.js');
  registryIds = connectors.map((c) => c.id);
  withSignal = capabilities.connectorsWithSkillInvocationSignal();
  withoutSignal = capabilities.connectorsWithoutSkillInvocationSignal();
  hasSkillInvocationSignal = capabilities.hasSkillInvocationSignal;

  for (const [id, build] of Object.entries(NORMALIZER_FIXTURES)) {
    rowsByConnector.set(id, await build());
  }
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('skill-invocation signal declaration', () => {
  it('classifies every registered connector exactly once', () => {
    expect([...withSignal, ...withoutSignal].sort()).toEqual([...registryIds].sort());
    expect(withSignal.filter((id) => withoutSignal.includes(id))).toEqual([]);
    for (const id of withSignal) expect(hasSkillInvocationSignal(id)).toBe(true);
    for (const id of withoutSignal) expect(hasSkillInvocationSignal(id)).toBe(false);
  });

  it('declares a signal for Claude Code, whose column is derived in SQL', () => {
    // The only connector with no TypeScript normalizer — its projection is
    // covered end to end by skills.integration.test.ts.
    expect(hasSkillInvocationSignal('claude-code')).toBe(true);
    expect(Object.keys(NORMALIZER_FIXTURES)).not.toContain('claude-code');
  });

  it('covers every TypeScript normalizer with a fixture', () => {
    const normalizerIds = registryIds.filter((id) => id !== 'claude-code');
    expect(Object.keys(NORMALIZER_FIXTURES).sort()).toEqual([...normalizerIds].sort());
  });
});

/** Agents that record the load as a call of their own. */
const NATIVE_CALL = ['grok', 'opencode', 'junie'];
/** Agents that load a skill by reading its SKILL.md. */
const FILE_READ = ['codex', 'pi', 'copilot', 'antigravity'];

describe('connectors that declare a skill-invocation signal', () => {
  it('is every TypeScript normalizer, split by how the load is recorded', () => {
    expect([...NATIVE_CALL, ...FILE_READ].sort()).toEqual(
      Object.keys(NORMALIZER_FIXTURES).sort(),
    );
  });

  it.each(NATIVE_CALL)('records the native call as a canonical Skill block (%s)', (id) => {
    expect(hasSkillInvocationSignal(id)).toBe(true);
    const rows = rowsByConnector.get(id)!;
    expect(rows.length).toBeGreaterThan(0);
    const named = rows.filter((r) => r.skill_names !== '');
    expect(named.length).toBe(1);
    expect(named[0]!.skill_names.split(',')).toContain(SKILL);
    expect(named[0]!.tool_names.split(',')).toContain('Skill');
  });

  it.each(FILE_READ)('names the skill from the SKILL.md read without inventing a call (%s)', (id) => {
    expect(hasSkillInvocationSignal(id)).toBe(true);
    const rows = rowsByConnector.get(id)!;
    expect(rows.length).toBeGreaterThan(0);
    const named = rows.filter((r) => r.skill_names !== '');
    expect(named.length).toBe(1);
    expect(named[0]!.skill_names.split(',')).toContain(SKILL);
    // The read stays the read — a `Skill` block here would be a fabricated call.
    expect(rows.some((r) => r.tool_names.split(',').includes('Skill'))).toBe(false);
  });
});

describe('connectors whose format records no skill invocation', () => {
  it('leave skill_names empty on every row', () => {
    // Empty today; the guard stays so a future connector classified here is
    // checked the moment it lands, never a fabricated name.
    for (const id of withoutSignal) {
      expect(hasSkillInvocationSignal(id)).toBe(false);
      const rows = rowsByConnector.get(id)!;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.skill_names === '')).toBe(true);
      expect(rows.some((r) => r.tool_names.split(',').includes('Skill'))).toBe(false);
    }
  });
});
