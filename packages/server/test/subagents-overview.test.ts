/**
 * Unit tests for the pure subagents rollup (`buildSubagentsResponse`) over
 * synthetic connector entries. No DuckDB index and no real agent home dir is
 * touched.
 *
 * Only the edges where a wrong answer is plausible and silent: usage that must
 * stay ABSENT for an agent whose format names no spawned subagent, a spawn
 * recorded under an alias rather than the definition's name, an alias that
 * must NOT claim another definition's spawns, a shared definition reported
 * through `visibleTo`, and built-ins landing in the unlocated bucket.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubagentEntry } from '../src/connectors/types.js';
import type {
  ConnectorSubagentEntries,
  SubagentsConnectorInfo,
  SubagentUsageIndex,
} from '../src/data/subagents.js';
import type { SubagentsResponse } from '@claudescope/shared';

const work = realpathSync(mkdtempSync(join(tmpdir(), 'claudescope-subagents-')));

// Sandbox every agent source before the modules load.
process.env.CLAUDE_PROJECTS_DIR = join(work, 'claude-empty', 'projects');
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty', 'sessions');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty', 'sessions');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty', 'sessions');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.OPENCODE_CONFIG_DIR = join(work, 'opencode-config-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty', 'sessions');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-desktop-empty');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty', 'sessions');
process.env.CLAUDESCOPE_HOME = join(work, 'home');

let buildSubagentsResponse: (
  infos: SubagentsConnectorInfo[],
  collected: ConnectorSubagentEntries[],
  usage: SubagentUsageIndex,
) => SubagentsResponse;

beforeAll(async () => {
  ({ buildSubagentsResponse } = await import('../src/data/subagents.js'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A synthetic connector entry — the shape a `subagents()` hook returns. */
function entry(over: Partial<SubagentEntry> & { name: string; path: string }): SubagentEntry {
  return {
    aliases: [],
    origin: 'user',
    realPath: over.path,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const info = (id: string, label = id): SubagentsConnectorInfo => ({ id, label, supported: true });

const usageIndex = (
  entries: Record<string, Record<string, { calls: number; sessions: number; lastUsedAt?: string }>>,
): SubagentUsageIndex =>
  new Map(Object.entries(entries).map(([agent, byName]) => [agent, new Map(Object.entries(byName))]));

describe('buildSubagentsResponse — usage signal', () => {
  it('leaves usage absent and unlocated empty for an agent whose format names no spawn', () => {
    // Junie is declared without a signal; rows under its id (a legacy row, a
    // shared name) must NOT become figures or an invented unlocated list.
    const collected: ConnectorSubagentEntries[] = [
      { connectorId: 'junie', entries: [entry({ name: 'helper', path: join(work, 'junie', 'agents', 'helper.md') })] },
    ];
    const usage = usageIndex({ junie: { helper: { calls: 3, sessions: 1 }, ghost: { calls: 2, sessions: 1 } } });
    const res = buildSubagentsResponse([info('junie', 'Junie')], collected, usage);
    const agent = res.agents[0]!;
    expect(agent.usageSignal).toBe(false);
    expect(agent.usageNote).toBeDefined();
    expect(agent.subagents[0]!.usage).toBeUndefined();
    expect(agent.unlocated).toEqual([]);
    expect(res.connectors[0]).toMatchObject({ installed: 1, used: 0, neverUsed: 0, unlocated: 0 });
  });
});

describe('buildSubagentsResponse — usage join', () => {
  it('sums spawns recorded under the name and an alias, latest last use', () => {
    const collected: ConnectorSubagentEntries[] = [
      {
        connectorId: 'copilot',
        entries: [entry({ name: 'Code Reviewer', aliases: ['code-reviewer'], path: join(work, 'copilot', 'code-reviewer.agent.md') })],
      },
    ];
    const usage = usageIndex({
      copilot: {
        'Code Reviewer': { calls: 1, sessions: 1, lastUsedAt: '2026-01-01T10:00:00.000Z' },
        'code-reviewer': { calls: 2, sessions: 2, lastUsedAt: '2026-02-01T10:00:00.000Z' },
      },
    });
    const agent = buildSubagentsResponse([info('copilot')], collected, usage).agents[0]!;
    expect(agent.subagents[0]!.usage).toEqual({ calls: 3, sessions: 3, lastUsedAt: '2026-02-01T10:00:00.000Z' });
    expect(agent.unlocated).toEqual([]);
  });

  it("never lets an alias claim the spawns of another definition's name", () => {
    // A plugin agent's unprefixed alias `reviewer` collides with a user agent
    // actually named `reviewer`: those spawns are the user agent's alone.
    const collected: ConnectorSubagentEntries[] = [
      {
        connectorId: 'claude-code',
        entries: [
          entry({ name: 'reviewer', path: join(work, 'claude', 'agents', 'reviewer.md') }),
          entry({
            name: 'myplug:reviewer',
            aliases: ['reviewer'],
            origin: 'plugin',
            path: join(work, 'plugin', 'agents', 'reviewer.md'),
          }),
        ],
      },
    ];
    const usage = usageIndex({ 'claude-code': { reviewer: { calls: 4, sessions: 2 } } });
    const agent = buildSubagentsResponse([info('claude-code')], collected, usage).agents[0]!;
    const byName = new Map(agent.subagents.map((s) => [s.name, s]));
    expect(byName.get('reviewer')!.usage).toEqual({ calls: 4, sessions: 2 });
    expect(byName.get('myplug:reviewer')!.usage).toBeUndefined();
  });

  it('counts an alias two definitions share for neither, leaving it unlocated', () => {
    const collected: ConnectorSubagentEntries[] = [
      {
        connectorId: 'claude-code',
        entries: ['one', 'two'].map((plugin) =>
          entry({
            name: `${plugin}:reviewer`,
            aliases: ['reviewer'],
            origin: 'plugin',
            path: join(work, plugin, 'agents', 'reviewer.md'),
          }),
        ),
      },
    ];
    const usage = usageIndex({ 'claude-code': { reviewer: { calls: 3, sessions: 1 } } });
    const agent = buildSubagentsResponse([info('claude-code')], collected, usage).agents[0]!;
    expect(agent.subagents.map((s) => s.usage)).toEqual([undefined, undefined]);
    expect(agent.unlocated).toEqual([{ name: 'reviewer', usage: { calls: 3, sessions: 1 } }]);
  });

  it('lists spawned-but-undefined names (built-ins) as unlocated, busiest first', () => {
    const collected: ConnectorSubagentEntries[] = [
      { connectorId: 'claude-code', entries: [entry({ name: 'mine', path: join(work, 'claude', 'agents', 'mine.md') })] },
    ];
    const usage = usageIndex({
      'claude-code': {
        mine: { calls: 1, sessions: 1 },
        Explore: { calls: 2, sessions: 1 },
        'general-purpose': { calls: 5, sessions: 3 },
      },
    });
    const res = buildSubagentsResponse([info('claude-code')], collected, usage);
    expect(res.agents[0]!.unlocated.map((u) => u.name)).toEqual(['general-purpose', 'Explore']);
    expect(res.connectors[0]).toMatchObject({ installed: 1, used: 1, neverUsed: 0, unlocated: 2 });
  });
});

describe('buildSubagentsResponse — shared definitions', () => {
  it('names the other agents that read the same definition, never itself', () => {
    const shared = join(work, 'shared', 'agents', 'helper.md');
    const collected: ConnectorSubagentEntries[] = [
      { connectorId: 'claude-code', entries: [entry({ name: 'helper', path: join(work, 'claude', 'agents', 'helper.md'), realPath: shared })] },
      { connectorId: 'opencode', entries: [entry({ name: 'helper', path: shared, origin: 'shared' })] },
    ];
    const res = buildSubagentsResponse([info('claude-code'), info('opencode')], collected, new Map());
    const byAgent = new Map(res.agents.map((a) => [a.connectorId, a.subagents[0]!]));
    expect(byAgent.get('claude-code')!.visibleTo).toEqual(['opencode']);
    expect(byAgent.get('claude-code')!.realPath).toBe(shared);
    expect(byAgent.get('opencode')!.visibleTo).toEqual(['claude-code']);
    expect(byAgent.get('opencode')!.realPath).toBeUndefined();
  });
});
