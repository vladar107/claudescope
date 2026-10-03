/**
 * Grok CLI extensions (MCP servers, hooks, plugins) — read live from `~/.grok`,
 * never indexed.
 *   - MCP: `[mcp_servers.<name>]` in `config.toml`
 *   - hooks: `hooks/*.json`
 *   - plugins: each dir under `plugins/` (except `marketplaces`, the
 *     marketplace clones) plus `[plugins] paths` entries inside the Grok home
 * Formats: https://docs.x.ai/build/settings , …/features/mcp-servers ,
 * …/features/hooks , …/features/skills-plugins-marketplaces.
 * Grok's compat imports of other agents' configs (~/.claude.json, .mcp.json)
 * are deliberately not read — they belong to those agents.
 *
 * STRICTLY READ-ONLY with respect to ~/.grok — files are only ever read.
 */

import { realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { grokHome } from '../../settings.js';
import { rec } from '../json.js';
import type { HookEntry, McpServerEntry, PluginEntry } from '../types.js';
import { filesIn, readTomlFile, subdirsOf } from '../extensions/config-files.js';
import { readClaudeStyleHooksFile } from '../extensions/hooks.js';
import { mcpServersFrom } from '../extensions/mcp.js';
import { readPluginBundle, type PluginBundle } from '../extensions/plugin-bundle.js';

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function bundles(): PluginBundle[] {
  const home = grokHome();
  const realHome = realpathOrNull(home) ?? home;
  const dirs = subdirsOf(join(home, 'plugins'))
    .filter((n) => n !== 'marketplaces')
    .map((n) => join(home, 'plugins', n));
  const paths = rec(rec(readTomlFile(join(home, 'config.toml'))).plugins).paths;
  if (Array.isArray(paths)) {
    for (const p of paths) {
      if (typeof p !== 'string' || !isAbsolute(p)) continue;
      const real = realpathOrNull(p);
      if (real === null) continue;
      const rel = relative(realHome, real);
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) dirs.push(p);
    }
  }
  const seen = new Set<string>();
  return dirs
    .filter((dir) => {
      const real = realpathOrNull(dir) ?? dir;
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    })
    .map((dir) => readPluginBundle(dir, { name: basename(dir) }));
}

export function grokMcpServers(): McpServerEntry[] {
  const path = join(grokHome(), 'config.toml');
  const user = mcpServersFrom(rec(readTomlFile(path)).mcp_servers, { scope: 'user', sourcePath: path });
  return [...user, ...bundles().flatMap((b) => b.mcpServers)];
}

export function grokHookEntries(): HookEntry[] {
  const user = filesIn(join(grokHome(), 'hooks'), '.json').flatMap((f) =>
    readClaudeStyleHooksFile(f, { scope: 'user' }),
  );
  return [...user, ...bundles().flatMap((b) => b.hooks)];
}

export function grokPlugins(): PluginEntry[] {
  return bundles().map((b) => b.plugin);
}
