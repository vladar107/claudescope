/**
 * Claude Code extensions inventory — MCP servers, hooks, and plugins, read live
 * (never indexed) from `~/.claude`.
 *
 *   - MCP: `.claude.json` — inside `CLAUDE_CONFIG_DIR` when set there, else
 *     beside the config dir. Only its `mcpServers` (user scope) and each
 *     `projects[<cwd>].mcpServers` (project scope) are picked; the rest of that
 *     file (OAuth data, history) is never read out.
 *   - hooks: `settings.json` `hooks` (user scope).
 *   - plugins: every install in `installed_plugins.json`, enabled unless
 *     `settings.json` `enabledPlugins[<name>@<marketplace>]` is `false`.
 *     Their bundled MCP servers and hooks are listed too.
 *
 * STRICTLY READ-ONLY with respect to ~/.claude — files are only ever read.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { SkillPlugin } from '@claudescope/shared';
import { claudeHome } from '../../settings.js';
import { rec } from '../json.js';
import { readJsonFile } from '../extensions/config-files.js';
import { readClaudeStyleHooksFile } from '../extensions/hooks.js';
import { mcpServersFrom } from '../extensions/mcp.js';
import { readPluginBundle, type PluginBundle } from '../extensions/plugin-bundle.js';
import type { HookEntry, McpServerEntry, PluginEntry } from '../types.js';
import { readInstalledPlugins } from './skills.js';

function claudeJsonPath(): string {
  const inside = join(claudeHome(), '.claude.json');
  return existsSync(inside) ? inside : join(dirname(claudeHome()), '.claude.json');
}

function settingsPath(): string {
  return join(claudeHome(), 'settings.json');
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function bundles(): PluginBundle[] {
  const enabledPlugins = rec(rec(readJsonFile(settingsPath())).enabledPlugins);
  const out: PluginBundle[] = [];
  const seen = new Set<string>();
  for (const [key, installs] of Object.entries(readInstalledPlugins())) {
    const [name, marketplace] = key.split('@');
    if (!name || !Array.isArray(installs)) continue;
    for (const install of installs) {
      if (typeof install?.installPath !== 'string' || !isAbsolute(install.installPath)) continue;
      const real = realpathOrSelf(install.installPath);
      if (seen.has(real)) continue;
      seen.add(real);
      const plugin: SkillPlugin = {
        name,
        ...(marketplace ? { marketplace } : {}),
        ...(install.version ? { version: install.version } : {}),
      };
      out.push(readPluginBundle(install.installPath, plugin, enabledPlugins[key] === false ? false : undefined));
    }
  }
  return out;
}

export function claudeCodeMcpServers(): McpServerEntry[] {
  const path = claudeJsonPath();
  const file = rec(readJsonFile(path));
  const out = mcpServersFrom(file.mcpServers, { scope: 'user', sourcePath: path });
  for (const [project, cfg] of Object.entries(rec(file.projects))) {
    out.push(...mcpServersFrom(rec(cfg).mcpServers, { scope: 'project', sourcePath: path, project }));
  }
  return [...out, ...bundles().flatMap((b) => b.mcpServers)];
}

export function claudeCodeHooks(): HookEntry[] {
  return [...readClaudeStyleHooksFile(settingsPath(), { scope: 'user' }), ...bundles().flatMap((b) => b.hooks)];
}

export function claudeCodePlugins(): PluginEntry[] {
  return bundles().map((b) => b.plugin);
}
