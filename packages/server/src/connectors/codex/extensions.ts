/**
 * Codex extensions inventory — MCP servers, hooks, and plugins, read live
 * (never indexed) from `~/.codex`.
 *
 *   - MCP: `config.toml` `[mcp_servers.<name>]` (user scope).
 *   - hooks: `hooks.json` plus `config.toml` `[[hooks.<Event>]]` (user scope);
 *     the `hooks.state` trust records are skipped by the shared parser.
 *   - plugins: the plugin cache is the inventory (`config.toml` lists only some
 *     plugins), the newest version dir of each, as `codex/skills.ts` finds
 *     them. Disabled only when `config.toml` `plugins["<name>@<marketplace>"]`
 *     says `enabled = false`. Bundled MCP servers and hooks are listed too.
 *
 * STRICTLY READ-ONLY with respect to ~/.codex — files are only ever read.
 */

import { join } from 'node:path';
import { codexHome } from '../../settings.js';
import { rec } from '../json.js';
import { readTomlFile } from '../extensions/config-files.js';
import { claudeStyleHooks, readClaudeStyleHooksFile } from '../extensions/hooks.js';
import { mcpServersFrom } from '../extensions/mcp.js';
import { readPluginBundle, type PluginBundle } from '../extensions/plugin-bundle.js';
import type { HookEntry, McpServerEntry, PluginEntry } from '../types.js';
import { newestVersionDir, subdirs } from './skills.js';

function configPath(): string {
  return join(codexHome(), 'config.toml');
}

function bundles(): PluginBundle[] {
  const enabled = rec(rec(readTomlFile(configPath())).plugins);
  const cache = join(codexHome(), 'plugins', 'cache');
  const out: PluginBundle[] = [];
  for (const marketplace of subdirs(cache)) {
    for (const name of subdirs(join(cache, marketplace))) {
      const pluginDir = join(cache, marketplace, name);
      // A version dir removed mid-update must cost only this plugin, not
      // every Codex list.
      let version: string | undefined;
      try {
        version = newestVersionDir(pluginDir);
      } catch {
        continue;
      }
      if (!version) continue;
      const off = rec(enabled[`${name}@${marketplace}`]).enabled === false;
      out.push(readPluginBundle(join(pluginDir, version), { name, marketplace, version }, off ? false : undefined));
    }
  }
  return out;
}

export function codexMcpServers(): McpServerEntry[] {
  const path = configPath();
  const servers = mcpServersFrom(rec(readTomlFile(path)).mcp_servers, { scope: 'user', sourcePath: path });
  return [...servers, ...bundles().flatMap((b) => b.mcpServers)];
}

export function codexHooks(): HookEntry[] {
  const path = configPath();
  return [
    ...readClaudeStyleHooksFile(join(codexHome(), 'hooks.json'), { scope: 'user' }),
    ...claudeStyleHooks(rec(readTomlFile(path)).hooks, { scope: 'user', sourcePath: path }),
    ...bundles().flatMap((b) => b.hooks),
  ];
}

export function codexPlugins(): PluginEntry[] {
  return bundles().map((b) => b.plugin);
}
