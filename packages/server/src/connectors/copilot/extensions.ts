/**
 * GitHub Copilot CLI extensions (MCP servers, hooks, plugins) — read live from
 * `~/.copilot`, never indexed.
 *   - MCP: `mcp-config.json`
 *   - hooks: `hooks/*.json` and the `hooks` key of `settings.json`
 *   - plugins: `installed-plugins/<marketplace>/<plugin>/` and
 *     `installed-plugins/_direct/<id>/`
 * Formats: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference
 * (also …/hooks-reference, …/cli-plugin-reference).
 *
 * STRICTLY READ-ONLY with respect to ~/.copilot — files are only ever read.
 */

import { join } from 'node:path';
import { copilotHome } from '../../settings.js';
import { rec } from '../json.js';
import type { HookEntry, McpServerEntry, PluginEntry } from '../types.js';
import { filesIn, readJsonFile, subdirsOf } from '../extensions/config-files.js';
import { copilotHooks } from '../extensions/hooks.js';
import { readMcpJsonFile } from '../extensions/mcp.js';
import { readPluginBundle, type PluginBundle } from '../extensions/plugin-bundle.js';

/** Plugins installed outside any marketplace live under this pseudo-marketplace dir. */
const DIRECT = '_direct';

function bundles(): PluginBundle[] {
  const base = join(copilotHome(), 'installed-plugins');
  const out: PluginBundle[] = [];
  for (const group of subdirsOf(base)) {
    for (const name of subdirsOf(join(base, group))) {
      out.push(
        readPluginBundle(join(base, group, name), group === DIRECT ? { name } : { name, marketplace: group }),
      );
    }
  }
  return out;
}

export function copilotMcpServers(): McpServerEntry[] {
  const user = readMcpJsonFile(join(copilotHome(), 'mcp-config.json'), { scope: 'user' });
  return [...user, ...bundles().flatMap((b) => b.mcpServers)];
}

export function copilotHookEntries(): HookEntry[] {
  const home = copilotHome();
  const out: HookEntry[] = [];
  for (const file of filesIn(join(home, 'hooks'), '.json')) {
    out.push(...copilotHooks(readJsonFile(file), { scope: 'user', sourcePath: file }));
  }
  const settingsPath = join(home, 'settings.json');
  const inline = rec(readJsonFile(settingsPath)).hooks;
  if (inline !== undefined) out.push(...copilotHooks({ hooks: inline }, { scope: 'user', sourcePath: settingsPath }));
  return [...out, ...bundles().flatMap((b) => b.hooks)];
}

export function copilotPlugins(): PluginEntry[] {
  return bundles().map((b) => b.plugin);
}
