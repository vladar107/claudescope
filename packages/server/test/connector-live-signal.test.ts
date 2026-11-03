/**
 * Fitness function for the live-state capability declarations.
 *
 * `LIVE_STATE_SIGNAL` says whether a connector's thread tail can be read as a
 * live state; `SESSION_END_SIGNAL` says whether its format writes an explicit
 * end marker. Every registered connector must be classified on exactly one
 * side of each. Copilot's `endedAt` (set by a shutdown, cleared on resume) is
 * pinned below; `deriveLiveState` honouring `endedAt` only for declared
 * connectors is covered in live-state.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'claudescope-livesignal-'));
const copilotDir = join(work, 'copilot');

process.env.CLAUDE_PROJECTS_DIR = join(work, 'claude-empty');
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = copilotDir;
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-desktop-empty');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty');
process.env.CLAUDESCOPE_HOME = join(work, 'home');

const at = (s: number) => `2026-08-01T09:00:${String(s).padStart(2, '0')}.000Z`;

/** A Copilot events.jsonl: a turn, a shutdown, then optionally a resumed turn. */
function writeCopilot(name: string, resumed: boolean): string {
  const dir = join(copilotDir, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'events.jsonl');
  let n = 0;
  const ev = (type: string, data: unknown) => ({ type, data, id: `e${n}`, timestamp: at(n++), parentId: null });
  const rows = [
    ev('session.start', { sessionId: name, context: { cwd: '/tmp/liveproj', branch: 'main' } }),
    ev('user.message', { content: 'hello' }),
    ev('assistant.message', { messageId: 'm1', model: 'gpt-5-mini', content: 'hi' }),
    ev('session.shutdown', { tokenDetails: { input: { tokenCount: 10 }, output: { tokenCount: 5 } } }),
    ...(resumed
      ? [
          ev('user.message', { content: 'again' }),
          ev('assistant.message', { messageId: 'm2', model: 'gpt-5-mini', content: 'back' }),
        ]
      : []),
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

let registryIds: string[];
let caps: typeof import('../src/data/agent-capabilities.js');

beforeAll(async () => {
  caps = await import('../src/data/agent-capabilities.js');
  const { connectors } = await import('../src/connectors/registry.js');
  registryIds = connectors.map((c) => c.id);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('live-state signal declaration', () => {
  it('classifies every registered connector exactly once', () => {
    const all = [...caps.connectorsWithLiveStateSignal(), ...caps.connectorsWithoutLiveStateSignal()];
    expect(all.sort()).toEqual([...registryIds].sort());
    for (const id of caps.connectorsWithLiveStateSignal()) expect(caps.hasLiveStateSignal(id)).toBe(true);
    for (const id of caps.connectorsWithoutLiveStateSignal()) expect(caps.hasLiveStateSignal(id)).toBe(false);
  });
});

describe('session-end signal declaration', () => {
  it('classifies every registered connector exactly once', () => {
    const all = [...caps.connectorsWithSessionEndSignal(), ...caps.connectorsWithoutSessionEndSignal()];
    expect(all.sort()).toEqual([...registryIds].sort());
    for (const id of caps.connectorsWithSessionEndSignal()) expect(caps.hasSessionEndSignal(id)).toBe(true);
    for (const id of caps.connectorsWithoutSessionEndSignal()) expect(caps.hasSessionEndSignal(id)).toBe(false);
  });

  it('returns endedAt from a Copilot shutdown, without changing the indexed rows', async () => {
    const file = writeCopilot('shut', false);
    const { copilotConnector } = await import('../src/connectors/copilot/copilot.js');
    const { parseCopilotSession, toCanonicalRows } = await import('../src/connectors/copilot/normalize.js');
    const data = await copilotConnector.loadSession('shut', [file], { resolveImages: false });
    expect(data.endedAt).toBe(at(3));
    const session = parseCopilotSession(file)!;
    expect(session.endedAt).toBe(at(3));
    expect(JSON.stringify(toCanonicalRows(session, file))).not.toContain(at(3));
  });

  it('clears endedAt when the session resumes after the shutdown', async () => {
    const file = writeCopilot('resumed', true);
    const { copilotConnector } = await import('../src/connectors/copilot/copilot.js');
    const data = await copilotConnector.loadSession('resumed', [file]);
    expect(data.endedAt).toBeUndefined();
  });
});

describe('agent-message signal declaration', () => {
  it('classifies every registered connector exactly once', () => {
    const all = (['mid-run', 'spawn-result', 'none'] as const).flatMap((signal) => {
      const ids = caps.connectorsWithAgentMessageSignal(signal);
      for (const id of ids) expect(caps.agentMessageSignal(id)).toBe(signal);
      return ids;
    });
    expect(all.sort()).toEqual([...registryIds].sort());
  });

  it('gives only mid-run connectors an inter-agent hook', async () => {
    const { connectors } = await import('../src/connectors/registry.js');
    for (const c of connectors) {
      expect(c.interAgentSignals !== undefined, c.id).toBe(caps.agentMessageSignal(c.id) === 'mid-run');
    }
  });
});
