/**
 * What a manifest-style plugin install ships, for every agent that uses the
 * Claude-plugin layout or a close relative (Claude Code, Codex, Junie,
 * Copilot, Grok). Relative to the plugin root:
 *   - MCP servers: the manifest `mcpServers` (inline map, or a `./`-relative
 *     path to a JSON file), else `.mcp.json`, else `mcp.json`;
 *   - hooks: the manifest `hooks` (inline map, or path(s)), else
 *     `hooks/hooks.json`;
 *   - skills: whatever `readPluginSkills` finds.
 * Manifests are `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and
 * a root `plugin.json`. Best-effort and STRICTLY READ-ONLY; a path escaping
 * the plugin root is ignored.
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { SkillPlugin } from '@claudescope/shared';
import { rec, str } from '../json.js';
import { readPluginSkills } from '../plugin-skills.js';
import type { HookEntry, McpServerEntry, PluginEntry } from '../types.js';
import { readJsonFile } from './config-files.js';
import { claudeStyleHooks, readClaudeStyleHooksFile } from './hooks.js';
import { mcpServersFrom, readMcpJsonFile } from './mcp.js';

const MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json'];

/** One plugin install's manifest-derived inventory. */
export interface PluginBundle {
  plugin: PluginEntry;
  mcpServers: McpServerEntry[];
  hooks: HookEntry[];
}

/** `p` resolved under `root`, or `undefined` when it escapes — symlinks included. */
function insideRoot(root: string, p: string): string | undefined {
  if (p === '' || isAbsolute(p)) return undefined;
  const abs = resolve(root, p);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return undefined;
  }
  const rel = relative(realpathSync(root), real);
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : abs;
}

/** Manifest path field: a string or an array of strings, each kept inside `root`. */
function declaredPaths(root: string, decl: unknown): string[] | undefined {
  const paths = typeof decl === 'string' ? [decl] : Array.isArray(decl) ? decl : undefined;
  return paths
    ?.map((p) => (typeof p === 'string' ? insideRoot(root, p) : undefined))
    .filter((p): p is string => p !== undefined);
}

function readManifests(root: string): Array<{ path: string; data: Record<string, unknown> }> {
  const out: Array<{ path: string; data: Record<string, unknown> }> = [];
  for (const name of MANIFESTS) {
    const path = join(root, name);
    const data = readJsonFile(path);
    if (data && typeof data === 'object' && !Array.isArray(data)) out.push({ path, data: data as Record<string, unknown> });
  }
  return out;
}

function bundleMcp(root: string, manifests: ReturnType<typeof readManifests>, plugin: SkillPlugin): McpServerEntry[] {
  const src = { scope: 'plugin' as const, plugin };
  for (const m of manifests) {
    const decl = m.data.mcpServers;
    const paths = declaredPaths(root, decl);
    if (paths) return paths.flatMap((p) => readMcpJsonFile(p, src));
    if (decl && typeof decl === 'object') return mcpServersFrom(decl, { ...src, sourcePath: m.path });
  }
  for (const name of ['.mcp.json', 'mcp.json']) {
    const path = join(root, name);
    if (existsSync(path)) return readMcpJsonFile(path, src);
  }
  return [];
}

function bundleHooks(root: string, manifests: ReturnType<typeof readManifests>, plugin: SkillPlugin): HookEntry[] {
  const src = { scope: 'plugin' as const, plugin };
  for (const m of manifests) {
    const decl = m.data.hooks;
    const paths = declaredPaths(root, decl);
    if (paths) return paths.flatMap((p) => readClaudeStyleHooksFile(p, src));
    if (decl && typeof decl === 'object') {
      const inline = rec(decl);
      return claudeStyleHooks('hooks' in inline ? inline.hooks : inline, { ...src, sourcePath: m.path });
    }
  }
  return readClaudeStyleHooksFile(join(root, 'hooks', 'hooks.json'), src);
}

/**
 * The inventory of the plugin installed at `root`. `plugin` identifies it
 * (name/marketplace/version as the agent's registry records them); `enabled`
 * is the agent's own enable state, when it keeps one.
 */
export function readPluginBundle(root: string, plugin: SkillPlugin, enabled?: boolean): PluginBundle {
  const manifests = readManifests(root);
  // A disabled plugin's servers and hooks are configured but not live; they
  // carry the flag so they never read as active.
  const off = enabled === false ? { enabled: false } : {};
  const mcpServers = bundleMcp(root, manifests, plugin).map((s) => ({ ...s, ...off }));
  const hooks = bundleHooks(root, manifests, plugin).map((h) => ({ ...h, ...off }));
  const skills = readPluginSkills(root, plugin).length;
  const description = manifests.map((m) => str(m.data.description)).find((d) => d !== '');
  return {
    plugin: {
      name: plugin.name,
      ...(plugin.marketplace ? { marketplace: plugin.marketplace } : {}),
      ...(plugin.version ? { version: plugin.version } : {}),
      ...(description ? { description } : {}),
      kind: 'bundle',
      ...(enabled === false ? { enabled: false } : {}),
      contents: { skills, mcpServers: mcpServers.length, hooks: hooks.length },
      sourcePath: root,
    },
    mcpServers,
    hooks,
  };
}
