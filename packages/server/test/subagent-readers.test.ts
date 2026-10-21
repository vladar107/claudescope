/**
 * The subagent definition readers against sandboxed agent homes — only the
 * edges where a format's naming or filtering rules bite: a missing or broken
 * frontmatter falling back to the file stem, a plugin manifest `agents` list
 * replacing the default dir, nested plugin namespacing, opencode's
 * primary/disabled filtering across file and config, Copilot's `.agent.md`
 * vs `.md` collision, a malformed Codex TOML, a symlinked agents dir, and
 * Antigravity's `<name>/agent.md` layout with `subagent: false`.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const work = realpathSync(mkdtempSync(join(tmpdir(), 'claudescope-subagents-')));
const claudeHome = join(work, 'claude');
const codexHome = join(work, 'codex');
const opencodeConfig = join(work, 'opencode-config');
const copilotHome = join(work, 'copilot');
const piHome = join(work, 'pi', 'agent');
const geminiHome = join(work, 'gemini');

process.env.CLAUDE_PROJECTS_DIR = join(claudeHome, 'projects');
process.env.CODEX_SESSIONS_DIR = join(codexHome, 'sessions');
process.env.OPENCODE_CONFIG_DIR = opencodeConfig;
process.env.COPILOT_SESSIONS_DIR = join(copilotHome, 'session-state');
process.env.PI_SESSIONS_DIR = join(piHome, 'sessions');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie', 'sessions');
process.env.ANTIGRAVITY_CLI_DIR = join(geminiHome, 'antigravity-cli');
process.env.ANTIGRAVITY_DIR = join(geminiHome, 'antigravity');
process.env.CLAUDESCOPE_HOME = join(work, 'home');

const { claudeCodeSubagents } = await import('../src/connectors/claude-code/subagents.js');
const { codexSubagents } = await import('../src/connectors/codex/subagents.js');
const { opencodeSubagents } = await import('../src/connectors/opencode/subagents.js');
const { copilotSubagents } = await import('../src/connectors/copilot/subagents.js');
const { piSubagents } = await import('../src/connectors/pi/subagents.js');
const { antigravitySubagents } = await import('../src/connectors/antigravity/subagents.js');

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const md = (fm: Record<string, string>, body = 'You are an agent.'): string =>
  `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n${body}\n`;

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('Claude Code', () => {
  const pluginRoot = (name: string) => join(work, 'plugin-cache', name);

  it('skips user files without a frontmatter name, and never aliases a user agent by its stem', () => {
    const agents = join(claudeHome, 'agents');
    write(join(agents, 'plain.md'), 'No frontmatter at all.\n');
    write(join(agents, 'broken.md'), '---\nname: never-closed\ndescription: x\n');
    write(join(agents, 'nested', 'renamed-file.md'), md({ name: 'reviewer', description: 'Reviews', model: 'haiku' }));

    const byName = new Map(claudeCodeSubagents().filter((e) => e.origin === 'user').map((e) => [e.name, e]));
    expect([...byName.keys()].sort()).toEqual(['reviewer']);
    expect(byName.get('reviewer')).toMatchObject({ aliases: [], description: 'Reviews', model: 'haiku' });
  });

  it('namespaces plugin subdirs, and a manifest `agents` list replaces the default dir', () => {
    write(join(pluginRoot('nest'), 'agents', 'deep', 'inner', 'finder.md'), md({ name: 'seeker' }));
    write(join(pluginRoot('listed'), 'agents', 'ignored.md'), md({ name: 'ignored' }));
    write(join(pluginRoot('listed'), 'custom', 'chosen.md'), md({ name: 'chosen' }));
    write(join(pluginRoot('listed'), 'custom', 'unlisted.md'), md({ name: 'unlisted' }));
    write(
      join(pluginRoot('listed'), '.claude-plugin', 'plugin.json'),
      JSON.stringify({ agents: ['./custom/chosen.md', '../escape.md'] }),
    );
    write(
      join(claudeHome, 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'nest@market': [{ installPath: pluginRoot('nest'), version: '1.0.0' }],
          'listed@market': [{ installPath: pluginRoot('listed') }],
        },
      }),
    );

    const plugin = claudeCodeSubagents().filter((e) => e.origin === 'plugin');
    expect(plugin.map((e) => e.name).sort()).toEqual(['listed:chosen', 'nest:deep:inner:seeker']);
    expect(plugin.find((e) => e.name === 'nest:deep:inner:seeker')).toMatchObject({
      aliases: ['nest:deep:inner:finder', 'deep:inner:seeker'],
      plugin: { name: 'nest', marketplace: 'market', version: '1.0.0' },
    });
    expect(plugin.find((e) => e.name === 'listed:chosen')?.aliases).toEqual(['chosen']);
  });
});

describe('opencode', () => {
  it('drops primary and disabled agents, including a file disabled from the config', () => {
    const dir = join(opencodeConfig, 'agent');
    write(join(dir, 'helper.md'), md({ name: 'Display Helper', description: 'Helps', mode: 'subagent' }));
    write(join(dir, 'boss.md'), md({ description: 'Primary', mode: 'primary' }));
    write(join(dir, 'off.md'), md({ description: 'Off', disable: 'true' }));
    write(join(dir, 'killed.md'), md({ description: 'Disabled by config' }));
    write(join(opencodeConfig, 'agents', 'sub', 'tuned.md'), md({ mode: 'all' }));
    write(
      join(opencodeConfig, 'opencode.jsonc'),
      `{
        // config agents: keyed by name
        "agent": {
          "killed": { "disable": true },
          "tuned": { "model": "anthropic/claude-haiku", "description": "From config" },
          "boss": { "description": "Still primary via its file" },
          "build": { "model": "anthropic/claude-opus" },
          "only-config": { "description": "Lives in JSON", "mode": "subagent" },
          "lead": { "description": "Primary in JSON", "mode": "primary" },
        },
      }`,
    );

    const byName = new Map(opencodeSubagents().map((e) => [e.name, e]));
    expect([...byName.keys()].sort()).toEqual(['helper', 'only-config', 'tuned']);
    expect(byName.get('helper')?.aliases).toEqual(['Display Helper']);
    expect(byName.get('tuned')).toMatchObject({ description: 'From config', model: 'anthropic/claude-haiku' });
    expect(byName.get('only-config')?.path).toBe(join(opencodeConfig, 'opencode.jsonc'));
  });
});

describe('Copilot', () => {
  it('keeps one entry per id, preferring `.agent.md`, with the display name as an alias', () => {
    const dir = join(copilotHome, 'agents');
    write(join(dir, 'planner.agent.md'), md({ name: 'Planner Pro', description: 'agent.md wins' }));
    write(join(dir, 'planner.md'), md({ name: 'planner', description: 'shadowed' }));
    write(join(dir, 'tester.md'), md({ description: 'plain md' }));

    const entries = copilotSubagents();
    expect(entries.map((e) => e.name)).toEqual(['planner', 'tester']);
    expect(entries[0]).toMatchObject({ aliases: ['Planner Pro'], description: 'agent.md wins' });
    expect(entries[0]?.path.endsWith('planner.agent.md')).toBe(true);
  });
});

describe('Codex', () => {
  it('skips a malformed TOML on its own and falls back to the stem for a nameless one', () => {
    const dir = join(codexHome, 'agents');
    write(join(dir, 'bad.toml'), 'name = "unterminated\n');
    write(join(dir, 'nameless.toml'), 'description = "No name key"\n');
    write(join(dir, 'file-stem.toml'), 'name = "worker"\nmodel = "gpt-5.5"\ndeveloper_instructions = "x"\n');

    const byName = new Map(codexSubagents().map((e) => [e.name, e]));
    expect([...byName.keys()].sort()).toEqual(['nameless', 'worker']);
    expect(byName.get('worker')).toMatchObject({ aliases: ['file-stem'], model: 'gpt-5.5' });
  });
});

describe('pi', () => {
  it('resolves a symlinked agents dir to its real path', () => {
    const target = join(work, 'dotfiles', 'pi-agents');
    write(join(target, 'scout.md'), md({ name: 'scout' }));
    mkdirSync(piHome, { recursive: true });
    symlinkSync(target, join(piHome, 'agents'));

    const [entry] = piSubagents();
    expect(entry?.path).toBe(join(piHome, 'agents', 'scout.md'));
    expect(entry?.realPath).toBe(join(target, 'scout.md'));
  });
});

describe('Antigravity', () => {
  it('reads `<name>.md` and `<name>/agent.md`, dropping `subagent: false`', () => {
    const dir = join(geminiHome, 'config', 'agents');
    write(join(dir, 'flat.md'), md({ description: 'Flat' }));
    write(join(dir, 'boxed', 'agent.md'), md({ description: 'Dir layout' }));
    write(join(dir, 'boxed', 'notes.md'), 'not an agent\n');
    write(join(dir, 'main-only.md'), md({ name: 'main-only', subagent: 'false' }));

    const entries = antigravitySubagents();
    expect(entries.map((e) => e.name)).toEqual(['boxed', 'flat']);
    expect(entries[0]?.path).toBe(join(dir, 'boxed', 'agent.md'));
  });
});
