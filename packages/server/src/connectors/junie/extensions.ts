/**
 * Junie extensions inventory — MCP servers, hooks, and plugins, read live
 * (never indexed) from `~/.junie`.
 *
 *   - MCP: `mcp/mcp.json` (user scope).
 *   - hooks: `config.json` `hooks` (user scope).
 *   - plugins ("extensions"): `extensions/extensions.json` maps a marketplace id
 *     to `{ extensions: [<name>…] }`; each listed name that has an install dir
 *     at `extensions/<marketplaceId>/<name>/` (Claude-plugin layout) is a
 *     bundle. Their bundled MCP servers and hooks are listed too.
 *
 * STRICTLY READ-ONLY with respect to ~/.junie — files are only ever read.
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { junieHome } from '../../settings.js';
import { rec } from '../json.js';
import { readJsonFile } from '../extensions/config-files.js';
import { readClaudeStyleHooksFile } from '../extensions/hooks.js';
import { readMcpJsonFile } from '../extensions/mcp.js';
import { readPluginBundle, type PluginBundle } from '../extensions/plugin-bundle.js';
import type { HookEntry, McpServerEntry, PluginEntry } from '../types.js';

/** A marketplace id or extension name is one path segment — never a traversal. */
function isSafeSegment(s: string): boolean {
  return s !== '' && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\');
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function bundles(): PluginBundle[] {
  const dir = join(junieHome(), 'extensions');
  const out: PluginBundle[] = [];
  const seen = new Set<string>();
  for (const [marketplace, entry] of Object.entries(rec(readJsonFile(join(dir, 'extensions.json'))))) {
    if (!isSafeSegment(marketplace)) continue;
    const names = rec(entry).extensions;
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (typeof name !== 'string' || !isSafeSegment(name)) continue;
      const root = join(dir, marketplace, name);
      if (!existsSync(root)) continue;
      let real: string;
      let base: string;
      try {
        real = realpathSync(root);
        base = realpathSync(dir);
      } catch {
        continue;
      }
      if (!isInside(base, real) || seen.has(real)) continue;
      seen.add(real);
      out.push(readPluginBundle(root, { name, marketplace }));
    }
  }
  return out;
}

export function junieMcpServers(): McpServerEntry[] {
  return [
    ...readMcpJsonFile(join(junieHome(), 'mcp', 'mcp.json'), { scope: 'user' }),
    ...bundles().flatMap((b) => b.mcpServers),
  ];
}

export function junieHooks(): HookEntry[] {
  return [
    ...readClaudeStyleHooksFile(join(junieHome(), 'config.json'), { scope: 'user' }),
    ...bundles().flatMap((b) => b.hooks),
  ];
}

export function juniePlugins(): PluginEntry[] {
  return bundles().map((b) => b.plugin);
}
