/**
 * Claude Code subagent definitions — read live (never indexed) from `~/.claude`.
 *
 * Two stores:
 *   - user: `~/.claude/agents/**\/*.md`, named by the frontmatter `name`
 *     (subdirs only organise files; they add nothing to the name). A file
 *     without a `name` is documentation kept beside the agents — Claude Code
 *     skips it, so it is not listed.
 *   - plugin: every installed plugin (`installed_plugins.json`, as for skills)
 *     ships agents in its default `agents/` dir — or, when a manifest declares
 *     `agents` (a path or array of `.md` files), in exactly those, replacing
 *     the default. Claude Code spawns a plugin agent as `plugin:agent`, with
 *     `agents/` subdirs joining the name as `plugin:sub:agent`.
 *
 * STRICTLY READ-ONLY with respect to ~/.claude — files are only ever read.
 */

import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SkillPlugin } from '@claudescope/shared';
import { claudeHome } from '../../settings.js';
import { readAgentDir, readAgentFile, type AgentDirSpec } from '../agent-md.js';
import { manifestPaths, readManifests } from '../plugin-skills.js';
import type { SubagentEntry } from '../types.js';
import { readInstalledPlugins } from './skills.js';

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every agent one plugin install at `root` ships. */
function readPluginAgents(root: string, plugin: SkillPlugin): SubagentEntry[] {
  const base: Omit<AgentDirSpec, 'dir'> = {
    origin: 'plugin',
    plugin,
    namePrefix: `${plugin.name}:`,
    recursive: true,
    namespaceSubdirs: true,
  };
  const declared = readManifests(root).flatMap((m) => manifestPaths(root, m.agents));
  if (declared.length === 0) return readAgentDir({ ...base, dir: join(root, 'agents') });

  const out: SubagentEntry[] = [];
  for (const path of declared) {
    if (isDir(path)) {
      out.push(...readAgentDir({ ...base, dir: path }));
    } else {
      const entry = readAgentFile(path, base);
      if (entry) out.push(entry);
    }
  }
  return out;
}

function pluginAgents(): SubagentEntry[] {
  const out: SubagentEntry[] = [];
  for (const [key, installs] of Object.entries(readInstalledPlugins())) {
    const [name, marketplace] = key.split('@');
    if (!name || !Array.isArray(installs)) continue;
    for (const install of installs) {
      // A relative path would resolve against the daemon's cwd, not ~/.claude.
      if (typeof install?.installPath !== 'string' || !isAbsolute(install.installPath)) continue;
      const plugin: SkillPlugin = {
        name,
        ...(marketplace ? { marketplace } : {}),
        ...(install.version ? { version: install.version } : {}),
      };
      out.push(...readPluginAgents(install.installPath, plugin));
    }
  }
  return out;
}

/** User agents first, then every installed plugin's agents. */
export function claudeCodeSubagents(): SubagentEntry[] {
  const user = readAgentDir({
    dir: join(claudeHome(), 'agents'),
    origin: 'user',
    recursive: true,
    include: (fm) => fm.name !== undefined,
  });
  // A user agent is spawned by its `name` alone, so a stem alias could only
  // misattribute — `Explore.md` naming `repo-explorer` would claim the
  // built-in `Explore`'s spawns.
  return [...user.map((e) => ({ ...e, aliases: [] })), ...pluginAgents()];
}
