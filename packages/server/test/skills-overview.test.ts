/**
 * Unit tests for the skills inventory: the SKILL.md reader (`readSkillsDir` /
 * `parseSkillFrontmatter`) over a throwaway tree, and the pure rollup
 * (`buildSkillsResponse`) over synthetic connector entries. No DuckDB index and
 * no real agent home dir is touched.
 *
 * Only the bug-prone edges are covered — the ones where a wrong answer is
 * plausible and silent: symlinked installs (the whole reason `realPath`
 * exists), the two different dedupes (across agents → `visibleTo`, within one
 * agent → first-listed wins), usage that must stay ABSENT for an agent whose
 * format records no invocation, frontmatter shapes real skills use, and the
 * card ordering.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillEntry } from '../src/connectors/types.js';
import type { SkillDirSpec } from '../src/connectors/skill-md.js';
import type {
  ConnectorSkillEntries,
  SkillNameAliases,
  SkillsConnectorInfo,
  SkillUsageIndex,
} from '../src/data/skills.js';
import type { SkillsResponse } from '@claudescope/shared';

// `realpathSync` because macOS hands out `/var/folders/…` for a `/private/var`
// tree — without it EVERY entry would look symlinked and the `realPath` cases
// below would pass for the wrong reason.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'claudescope-skills-')));

// Sandbox every agent source AND every skills dir before the modules load.
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

let claudeCodeSkills: () => SkillEntry[];
let junieSkills: () => SkillEntry[];
let codexSkills: () => SkillEntry[];
let readSkillsDir: (spec: SkillDirSpec) => SkillEntry[];
let parseSkillFrontmatter: (raw: string) => { name?: string; description?: string };
let skillNameAliases: (collected: ConnectorSkillEntries[]) => SkillNameAliases;
let skillNameFoldSql: (agentExpr: string, skillExpr: string, aliases: SkillNameAliases) => string;
let buildSkillsResponse: (
  infos: SkillsConnectorInfo[],
  collected: ConnectorSkillEntries[],
  usage: SkillUsageIndex,
) => SkillsResponse;

beforeAll(async () => {
  ({ readSkillsDir, parseSkillFrontmatter } = await import('../src/connectors/skill-md.js'));
  ({ buildSkillsResponse, skillNameAliases, skillNameFoldSql } = await import('../src/data/skills.js'));
  ({ claudeCodeSkills } = await import('../src/connectors/claude-code/skills.js'));
  ({ junieSkills } = await import('../src/connectors/junie/skills.js'));
  ({ codexSkills } = await import('../src/connectors/codex/skills.js'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Write `<dir>/<name>/SKILL.md` with the given body and return the skill dir. */
function writeSkill(dir: string, name: string, body: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), body);
  return skillDir;
}

/** A tree of this test's own, so cases can't collide through a shared dir. */
function caseDir(name: string): string {
  const dir = join(work, 'cases', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A synthetic connector entry — the shape a `skills()` hook returns. */
function entry(over: Partial<SkillEntry> & { name: string; path: string }): SkillEntry {
  return {
    origin: 'user',
    dirName: over.name,
    realPath: over.path,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const info = (id: string, label = id, supported = true): SkillsConnectorInfo => ({
  id,
  label,
  supported,
});

const usageIndex = (
  entries: Record<string, Record<string, { calls: number; sessions: number; lastUsedAt?: string }>>,
): SkillUsageIndex =>
  new Map(Object.entries(entries).map(([agent, byName]) => [agent, new Map(Object.entries(byName))]));

describe('readSkillsDir — symlinks', () => {
  it('reports realPath only for an install reached through a symlink', () => {
    const root = caseDir('symlink');
    const store = join(root, 'skills');
    mkdirSync(store, { recursive: true });
    writeSkill(store, 'plain', '---\nname: plain\ndescription: A plain one\n---\n');
    const target = writeSkill(join(root, 'elsewhere'), 'linked', '---\nname: linked\ndescription: Linked\n---\n');
    symlinkSync(target, join(store, 'linked'), 'dir');

    const entries = readSkillsDir({ dir: store, origin: 'user' });
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect([...byName.keys()].sort()).toEqual(['linked', 'plain']);

    // A plain dir resolves to itself — the data layer drops `realPath` then.
    expect(byName.get('plain')!.realPath).toBe(byName.get('plain')!.path);
    expect(byName.get('linked')!.path).toBe(join(store, 'linked'));
    expect(byName.get('linked')!.realPath).toBe(target);

    const res = buildSkillsResponse(
      [info('claude-code', 'Claude Code')],
      [{ connectorId: 'claude-code', entries }],
      new Map(),
    );
    const skills = new Map(res.agents[0]!.skills.map((s) => [s.name, s]));
    expect(skills.get('plain')!.realPath).toBeUndefined();
    expect(skills.get('linked')!.sourcePath).toBe(join(store, 'linked'));
    expect(skills.get('linked')!.realPath).toBe(target);
  });
});

describe('readSkillsDir — frontmatter and entry shapes', () => {
  it('falls back to the dir name when there is no frontmatter', () => {
    const store = join(caseDir('no-frontmatter'), 'skills');
    writeSkill(store, 'bare-skill', '# Bare skill\n\nJust prose, no frontmatter block.\n');
    const [only] = readSkillsDir({ dir: store, origin: 'user' });
    expect(only!.name).toBe('bare-skill');
    expect(only!.description).toBeUndefined();
  });

  it('joins a folded description block and unquotes quoted values', () => {
    expect(
      parseSkillFrontmatter(
        [
          '---',
          'name: "quoted-name"',
          'description: >',
          '  This skill should be used when the user',
          '  asks about time, dates, or anything dated.',
          '---',
          '',
          '# body',
        ].join('\n'),
      ),
    ).toEqual({
      name: 'quoted-name',
      description:
        'This skill should be used when the user asks about time, dates, or anything dated.',
    });
  });

  it("returns {} when the frontmatter block is never closed", () => {
    expect(parseSkillFrontmatter('---\nname: half\ndescription: truncated\n')).toEqual({});
  });

  it('skips dot-entries and, with rootFiles, a root .md carrying no description', () => {
    const store = join(caseDir('root-files'), 'skills');
    writeSkill(store, 'kept', '---\nname: kept\ndescription: Kept\n---\n');
    writeSkill(store, '.system', '---\nname: hidden\ndescription: Hidden\n---\n');
    writeFileSync(join(store, 'described.md'), '---\nname: described\ndescription: A one-filer\n---\n');
    writeFileSync(join(store, 'plain-note.md'), '---\nname: plain-note\n---\n# notes\n');

    const names = readSkillsDir({ dir: store, origin: 'user', rootFiles: true }).map((e) => e.name);
    // `.system` is only reachable when a connector names it explicitly (Codex);
    // a description-less root `.md` is a note, not a skill.
    expect(names.sort()).toEqual(['described', 'kept']);
  });

  it('prefixes a plugin spec so the name matches what the agent invokes', () => {
    const store = join(caseDir('plugin'), 'cache', 'myplug', 'skills');
    writeSkill(store, 'bar', '---\nname: bar\ndescription: Plugin skill\n---\n');
    const [only] = readSkillsDir({
      dir: store,
      origin: 'plugin',
      plugin: { name: 'myplug', marketplace: 'mkt' },
      namePrefix: 'myplug:',
    });
    expect(only!.name).toBe('myplug:bar');
    expect(only!.origin).toBe('plugin');
    expect(only!.plugin).toEqual({ name: 'myplug', marketplace: 'mkt' });
  });

  it('returns [] for an absent dir', () => {
    expect(readSkillsDir({ dir: join(work, 'nope', 'skills'), origin: 'user' })).toEqual([]);
  });
});

describe('claudeCodeSkills — plugin manifest edges', () => {
  // `claudeHome()` is the parent of CLAUDE_PROJECTS_DIR, so this is the
  // sandboxed `~/.claude`.
  const home = join(work, 'claude-empty');
  const manifest = join(home, 'plugins', 'installed_plugins.json');

  function withManifest(json: string): SkillEntry[] {
    mkdirSync(join(home, 'plugins'), { recursive: true });
    writeFileSync(manifest, json);
    return claudeCodeSkills();
  }

  it('keeps the user skills when the manifest is null or malformed', () => {
    writeSkill(join(home, 'skills'), 'own', '---\nname: own\n---\n');
    expect(withManifest('null').map((e) => e.name)).toEqual(['own']);
    expect(withManifest('{"version":2,"plugins":null}').map((e) => e.name)).toEqual(['own']);
    expect(withManifest('{"version":2,"plugins":{"p@m":[null, 7]}}').map((e) => e.name)).toEqual(['own']);
  });

  it('follows only absolute install paths', () => {
    const cache = caseDir('plugin-cache');
    writeSkill(join(cache, 'skills'), 'bar', '---\nname: bar\n---\n');
    const entries = withManifest(
      JSON.stringify({
        version: 2,
        plugins: {
          'rel@m': [{ scope: 'user', installPath: 'packages/server' }],
          'abs@m': [{ scope: 'user', installPath: cache, version: '1.0.0' }],
        },
      }),
    );
    expect(entries.map((e) => e.name)).toEqual(['own', 'abs:bar']);
    expect(entries[1]?.plugin).toEqual({ name: 'abs', marketplace: 'm', version: '1.0.0' });
  });
});

describe('plugin layouts', () => {
  const home = join(work, 'claude-empty');
  const manifest = join(home, 'plugins', 'installed_plugins.json');

  function installClaudePlugin(name: string, root: string): SkillEntry[] {
    mkdirSync(join(home, 'plugins'), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ version: 2, plugins: { [`${name}@m`]: [{ scope: 'user', installPath: root, version: '1.0.0' }] } }));
    return claudeCodeSkills().filter((e) => e.origin === 'plugin');
  }

  it('reads the manifest skills path, commands, and the default dir — all namespaced', () => {
    // revdiff's layout: no `skills/`, the skill under `./.claude-plugin/skills/`.
    const root = caseDir('plugin-revdiff');
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'revdiff', skills: './.claude-plugin/skills/', commands: ['./cmds'] }));
    writeSkill(join(root, '.claude-plugin', 'skills'), 'revdiff', '---\nname: revdiff\ndescription: Review diffs.\n---\n');
    writeSkill(join(root, 'skills'), 'extra', '---\nname: extra\n---\n');
    mkdirSync(join(root, 'cmds'), { recursive: true });
    writeFileSync(join(root, 'cmds', 'lint.md'), '---\ndescription: Lint it.\n---\nRun the linter.\n');
    mkdirSync(join(root, 'commands'), { recursive: true });
    writeFileSync(join(root, 'commands', 'ignored.md'), 'replaced by the manifest commands path\n');
    const names = installClaudePlugin('revdiff', root).map((e) => [e.name, e.dirName]);
    expect(names).toEqual([
      ['revdiff:extra', 'extra'],
      ['revdiff:revdiff', 'revdiff'],
      ['revdiff:lint', 'lint'],
    ]);
  });

  it('drops a manifest path that escapes the plugin root', () => {
    const root = caseDir('plugin-escape');
    writeSkill(join(work, 'cases', 'outside-skills'), 'leak', '---\nname: leak\n---\n');
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: ['../outside-skills', '/etc'] }));
    expect(installClaudePlugin('esc', root)).toEqual([]);
  });

  it('falls back to a root SKILL.md when the plugin ships nothing else', () => {
    const root = caseDir('plugin-single');
    writeFileSync(join(root, 'SKILL.md'), '---\ndescription: One skill.\n---\n');
    const entries = installClaudePlugin('solo', root);
    expect(entries.map((e) => [e.name, e.dirName, e.description])).toEqual([['solo:solo', 'solo', 'One skill.']]);
  });

  it('reads the newest cached version of every Codex plugin, namespaced like Claude Code', () => {
    // `codexHome()` is the parent of CODEX_SESSIONS_DIR.
    const cache = join(work, 'codex-empty', 'plugins', 'cache');
    const oldV = join(cache, 'mkt', 'tool', '1.0.0');
    const newV = join(cache, 'mkt', 'tool', '2.0.0');
    writeSkill(join(oldV, 'skills'), 'stale', '---\nname: stale\n---\n');
    writeSkill(join(newV, 'skills'), 'history', '---\nname: history\n---\n');
    utimesSync(oldV, new Date('2026-01-01'), new Date('2026-01-01'));
    utimesSync(newV, new Date('2026-06-01'), new Date('2026-06-01'));
    const plugins = codexSkills().filter((e) => e.origin === 'plugin');
    expect(plugins.map((e) => [e.name, e.dirName, e.plugin?.version])).toEqual([['tool:history', 'history', '2.0.0']]);
  });
});

describe('junieSkills — bundled build', () => {
  it('reads the bundled skills of the NEWEST build, compared numerically', () => {
    // `junieHome()` is the parent of JUNIE_SESSIONS_DIR. Lexically '999.1' would
    // outrank '3196.5'; only a numeric compare picks the real newest build.
    const versions = join(work, 'junie-empty', 'versions');
    writeSkill(join(versions, '999.1', 'skills'), 'old', '---\nname: old\n---\n');
    writeSkill(join(versions, '3196.5', 'skills'), 'bundled', '---\nname: bundled\n---\n');
    writeSkill(join(versions, 'not-a-build', 'skills'), 'junk', '---\nname: junk\n---\n');
    expect(junieSkills().map((e) => [e.name, e.origin])).toEqual([['bundled', 'system']]);
  });
});

describe('buildSkillsResponse — dedupe', () => {
  it('names the other agents that see the same install, never itself', () => {
    const shared = join(work, 'agents', 'skills', 'shared-one');
    const collected: ConnectorSkillEntries[] = [
      { connectorId: 'claude-code', entries: [entry({ name: 'shared-one', path: shared })] },
      { connectorId: 'codex', entries: [entry({ name: 'shared-one', path: shared, origin: 'shared' })] },
      { connectorId: 'opencode', entries: [] },
    ];
    const res = buildSkillsResponse(
      [info('claude-code', 'Claude Code'), info('codex', 'Codex'), info('opencode', 'opencode')],
      collected,
      new Map(),
    );
    const byId = new Map(res.agents.map((a) => [a.connectorId, a]));
    expect(byId.get('claude-code')!.skills[0]!.visibleTo).toEqual(['codex']);
    expect(byId.get('codex')!.skills[0]!.visibleTo).toEqual(['claude-code']);
  });

  it('collapses two dirs of ONE agent resolving to the same install, first listed wins', () => {
    // opencode reads `~/.claude/skills` AND `~/.agents/skills`, which may be the
    // very same symlink target — one row, tagged with the primary dir's origin.
    const real = join(work, 'agents', 'skills', 'dup');
    const collected: ConnectorSkillEntries[] = [
      {
        connectorId: 'opencode',
        entries: [
          entry({ name: 'dup', path: join(work, 'opencode-config', 'skills', 'dup'), realPath: real, origin: 'user' }),
          entry({ name: 'dup', path: real, realPath: real, origin: 'shared' }),
        ],
      },
    ];
    const res = buildSkillsResponse([info('opencode', 'opencode')], collected, new Map());
    const agent = res.agents[0]!;
    expect(agent.skills).toHaveLength(1);
    expect(agent.skills[0]!.origin).toBe('user');
    expect(agent.skills[0]!.sourcePath).toBe(join(work, 'opencode-config', 'skills', 'dup'));
    expect(res.connectors[0]!.installed).toBe(1);
  });
});

describe('buildSkillsResponse — usage attribution', () => {
  const USAGE = { calls: 7, sessions: 3, lastUsedAt: '2026-02-01T10:00:00.000Z' };

  it('attaches usage and derives unlocated for an agent that records invocations', () => {
    const collected: ConnectorSkillEntries[] = [
      { connectorId: 'claude-code', entries: [entry({ name: 'now', path: join(work, 'claude', 'skills', 'now') })] },
    ];
    const usage = usageIndex({
      'claude-code': {
        now: USAGE,
        'rarely-used': { calls: 1, sessions: 1 },
        'project-scoped': { calls: 4, sessions: 2 },
      },
    });
    const res = buildSkillsResponse([info('claude-code', 'Claude Code')], collected, usage);
    const agent = res.agents[0]!;
    expect(agent.usageSignal).toBe(true);
    expect(agent.skills[0]!.usage).toEqual(USAGE);
    // Invoked but installed nowhere this agent reaches, busiest first.
    expect(agent.unlocated.map((u) => u.name)).toEqual(['project-scoped', 'rarely-used']);

    const overview = res.connectors[0]!;
    expect(overview.installed).toBe(1);
    expect(overview.used).toBe(1);
    expect(overview.neverUsed).toBe(0);
    expect(overview.unlocated).toBe(2);
  });

  it('leaves usage absent for an agent whose format records no invocation', () => {
    // Every registered agent has a signal today, so this is a future connector
    // (unclassified → no signal). The index can still carry rows under its id
    // (a legacy row, a name shared with another agent) — they must NOT become
    // figures.
    const collected: ConnectorSkillEntries[] = [
      { connectorId: 'future-agent', entries: [entry({ name: 'now', path: join(work, 'future', 'skills', 'now') })] },
    ];
    const usage = usageIndex({ 'future-agent': { now: USAGE, ghost: { calls: 2, sessions: 1 } } });
    const res = buildSkillsResponse([info('future-agent', 'Future')], collected, usage);
    const agent = res.agents[0]!;
    expect(agent.usageSignal).toBe(false);
    expect(agent.usageNote).toBeUndefined();
    expect(agent.skills[0]!.usage).toBeUndefined();
    // "Unlocated" is only knowable where usage is: no invented list, no 0 count.
    expect(agent.unlocated).toEqual([]);
    const overview = res.connectors[0]!;
    expect(overview.used).toBe(0);
    expect(overview.neverUsed).toBe(0);
    expect(overview.unlocated).toBe(0);
  });
});

describe('buildSkillsResponse — directory-name join', () => {
  it('attaches usage recorded under the directory name to a skill declared under another', () => {
    // A SKILL.md read names the DIRECTORY; the frontmatter may say otherwise.
    const collected: ConnectorSkillEntries[] = [
      { connectorId: 'codex', entries: [entry({ name: 'PR Review', dirName: 'pr-review', path: join(work, 'codex', 'skills', 'pr-review') })] },
    ];
    const usage = usageIndex({ codex: { 'pr-review': { calls: 4, sessions: 2, lastUsedAt: '2026-02-01T00:00:00.000Z' }, 'PR Review': { calls: 1, sessions: 1, lastUsedAt: '2026-03-01T00:00:00.000Z' } } });
    const res = buildSkillsResponse([info('codex', 'Codex')], collected, usage);
    const skill = res.agents[0]!.skills[0]!;
    expect(skill.usage).toEqual({ calls: 5, sessions: 3, lastUsedAt: '2026-03-01T00:00:00.000Z' });
    // Neither key is "unlocated": both belong to this install.
    expect(res.agents[0]!.unlocated).toEqual([]);
  });
});

describe('skillNameAliases', () => {
  it('maps a recorded directory name to the installed name, per agent, unless ambiguous', () => {
    const collected: ConnectorSkillEntries[] = [
      { connectorId: 'codex', entries: [
        entry({ name: 'claudescope:history', dirName: 'history', path: '/c/history' }),
        entry({ name: 'now', dirName: 'now', path: '/c/now' }),
        // Two installs share the dir name `shared` — nobody can say which one a read meant.
        entry({ name: 'a:shared', dirName: 'shared', path: '/c/a/shared' }),
        entry({ name: 'b:shared', dirName: 'shared', path: '/c/b/shared' }),
      ] },
      { connectorId: 'pi', entries: [entry({ name: 'PR Review', dirName: 'pr-review', path: '/p/pr-review' })] },
    ];
    const aliases = skillNameAliases(collected);
    expect([...aliases.get('codex')!]).toEqual([['history', 'claudescope:history']]);
    expect([...aliases.get('pi')!]).toEqual([['pr-review', 'PR Review']]);
    // Folding is a CASE over the same map; no aliases → the bare expression.
    expect(skillNameFoldSql('agent', 'skill', new Map())).toBe('skill');
    expect(skillNameFoldSql('agent', 'skill', aliases)).toBe(
      "CASE WHEN agent = 'codex' AND skill = 'history' THEN 'claudescope:history' WHEN agent = 'pi' AND skill = 'pr-review' THEN 'PR Review' ELSE skill END",
    );
  });
});

describe('buildSkillsResponse — card order', () => {
  it('ranks supported-with-skills, then supported-empty, then unsupported', () => {
    const collected: ConnectorSkillEntries[] = [
      { connectorId: 'grok', entries: [entry({ name: 'z-skill', path: join(work, 'grok', 'skills', 'z-skill') })] },
      { connectorId: 'codex', entries: [] },
    ];
    const res = buildSkillsResponse(
      [
        info('junie', 'Junie', false),
        info('codex', 'Codex'),
        info('grok', 'Grok CLI'),
      ],
      collected,
      new Map(),
    );
    expect(res.connectors.map((c) => c.connectorId)).toEqual(['grok', 'codex', 'junie']);
    // `agents` follows the card order and skips unsupported agents entirely.
    expect(res.agents.map((a) => a.connectorId)).toEqual(['grok', 'codex']);
  });

  it('previews the most recently updated skill, ties broken by name', () => {
    const skills = [
      entry({ name: 'old', path: join(work, 's', 'old'), updatedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ name: 'b-newest', path: join(work, 's', 'b-newest'), updatedAt: '2026-03-01T00:00:00.000Z', description: 'Newest' }),
      entry({ name: 'a-newest', path: join(work, 's', 'a-newest'), updatedAt: '2026-03-01T00:00:00.000Z', description: 'Also newest' }),
    ];
    const res = buildSkillsResponse(
      [info('claude-code', 'Claude Code')],
      [{ connectorId: 'claude-code', entries: skills }],
      new Map(),
    );
    expect(res.connectors[0]!.preview).toEqual({ name: 'a-newest', description: 'Also newest' });
  });
});
