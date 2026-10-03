/**
 * opencode extensions (MCP servers, plugins) — read live from
 * `~/.config/opencode`, never indexed.
 *   - MCP: the `mcp` key of `opencode.json` / `opencode.jsonc`
 *   - plugins: the `plugin` array of the same files (npm specs) and the
 *     `plugins/` (legacy `plugin/`) dirs of local `.js`/`.ts` files
 * No hooks: opencode hooks are code inside plugins, so they are unsupported.
 * Formats: https://opencode.ai/docs/mcp-servers/ , https://opencode.ai/docs/plugins/ ,
 * https://opencode.ai/docs/config/.
 *
 * STRICTLY READ-ONLY with respect to ~/.config/opencode — files are only ever read.
 */

import { basename, extname, join } from 'node:path';
import { opencodeConfigDir } from '../../settings.js';
import { rec } from '../json.js';
import type { McpServerEntry, PluginEntry } from '../types.js';
import { filesIn, readJsonFile } from '../extensions/config-files.js';
import { mcpServersFrom } from '../extensions/mcp.js';
import { sanitizeSource } from '../extensions/redact.js';

const CONFIG_FILES = ['opencode.json', 'opencode.jsonc'];
const PLUGIN_DIRS = ['plugins', 'plugin'];

function configs(): { path: string; config: Record<string, unknown> }[] {
  return CONFIG_FILES.map((f) => join(opencodeConfigDir(), f))
    .map((path) => ({ path, config: rec(readJsonFile(path)) }))
    .filter((c) => Object.keys(c.config).length > 0);
}

/** Splits a trailing `@version` off an npm spec, leaving a scoped name's leading `@` alone. */
function splitSpec(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec };
  const version = spec.slice(at + 1);
  return version && !version.includes('/') ? { name: spec, version } : { name: spec };
}

export function opencodeMcpServers(): McpServerEntry[] {
  return configs().flatMap(({ path, config }) => mcpServersFrom(config.mcp, { scope: 'user', sourcePath: path }));
}

export function opencodePlugins(): PluginEntry[] {
  const out: PluginEntry[] = [];
  for (const { path, config } of configs()) {
    if (!Array.isArray(config.plugin)) continue;
    for (const spec of config.plugin) {
      if (typeof spec !== 'string') continue;
      out.push({ ...splitSpec(sanitizeSource(spec)), kind: 'package', sourcePath: path });
    }
  }
  for (const dir of PLUGIN_DIRS) {
    for (const ext of ['.js', '.ts']) {
      for (const file of filesIn(join(opencodeConfigDir(), dir), ext)) {
        out.push({ name: basename(file, extname(file)), kind: 'file', sourcePath: file });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
