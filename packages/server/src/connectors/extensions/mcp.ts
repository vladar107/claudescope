/**
 * One normalizer for every agent's MCP server map. The formats are close
 * relatives, so field aliases cover them all:
 *   - Claude Code / Junie / Copilot / plugin `.mcp.json`: `mcpServers` of
 *     `{ type, command, args, env, url, headers }`;
 *   - Codex / Grok TOML `[mcp_servers.<name>]`: `http_headers`,
 *     `env_http_headers`, `bearer_token_env_var`, `enabled`;
 *   - opencode `mcp`: `type: local|remote`, `command` as an argv array,
 *     `environment`, `enabled`.
 * Credential slots keep their KEY names only; free-form strings go through
 * `redact.ts`. Nothing else of an entry is copied, so an unknown field can
 * never carry a secret out.
 */

import type { ExtensionScope, McpTransport, SkillPlugin } from '@claudescope/shared';
import { rec, str } from '../json.js';
import type { McpServerEntry } from '../types.js';
import { readJsonFile } from './config-files.js';
import { redactArgs, redactCommandLine, sanitizeUrl } from './redact.js';

/** Where a batch of servers is declared. */
export interface McpSource {
  scope: ExtensionScope;
  /** Absolute path of the declaring file. */
  sourcePath: string;
  /** Scope `project`: the absolute project cwd. */
  project?: string;
  plugin?: SkillPlugin;
}

function keysOf(...maps: unknown[]): string[] {
  const keys = new Set<string>();
  for (const m of maps) for (const k of Object.keys(rec(m))) keys.add(k);
  return [...keys].sort();
}

function transportOf(entry: Record<string, unknown>, hasCommand: boolean, hasUrl: boolean): McpTransport {
  const t = str(entry.type ?? entry.transport).toLowerCase();
  if (t === 'stdio' || t === 'local') return 'stdio';
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamable-http' || t === 'streamablehttp' || t === 'remote') return 'http';
  if (hasCommand) return 'stdio';
  if (hasUrl) return 'http';
  return 'unknown';
}

/** One server entry, reduced to its displayable, redacted fields. */
function toServer(name: string, raw: unknown, src: McpSource): McpServerEntry {
  const entry = rec(raw);

  let command: string | undefined;
  let args: string[] | undefined;
  if (Array.isArray(entry.command)) {
    // opencode: `command` is the whole argv.
    const argv = entry.command.filter((a): a is string => typeof a === 'string');
    command = argv[0];
    args = argv.slice(1);
  } else if (str(entry.command)) {
    command = str(entry.command);
    if (Array.isArray(entry.args)) args = entry.args.filter((a): a is string => typeof a === 'string');
  }

  const rawUrl = str(entry.url) || str(entry.serverUrl) || str(entry.httpUrl);
  const url = rawUrl ? sanitizeUrl(rawUrl) : undefined;

  const envKeys = keysOf(entry.env, entry.environment);
  // `env_vars` (Codex) forwards named host vars; the names are as safe as env keys.
  if (Array.isArray(entry.env_vars)) {
    for (const v of entry.env_vars) if (typeof v === 'string' && !envKeys.includes(v)) envKeys.push(v);
  }
  const headerKeys = keysOf(entry.headers, entry.http_headers, entry.env_http_headers);
  if (str(entry.bearer_token_env_var) && !headerKeys.includes('Authorization')) headerKeys.push('Authorization');

  const disabled = entry.enabled === false || entry.disabled === true;

  return {
    name,
    transport: transportOf(entry, command !== undefined, rawUrl !== ''),
    ...(command ? { command: redactCommandLine(command) } : {}),
    ...(args && args.length > 0 ? { args: redactArgs(args) } : {}),
    ...(rawUrl ? { url: url ?? '•••' } : {}),
    ...(envKeys.length > 0 ? { envKeys: envKeys.sort() } : {}),
    ...(headerKeys.length > 0 ? { headerKeys: headerKeys.sort() } : {}),
    ...(disabled ? { enabled: false } : {}),
    scope: src.scope,
    ...(src.project ? { project: src.project } : {}),
    ...(src.plugin ? { plugin: src.plugin } : {}),
    sourcePath: src.sourcePath,
  };
}

/** Every server in a `{ <name>: entry }` map, sorted by name; `[]` for anything else. */
export function mcpServersFrom(map: unknown, src: McpSource): McpServerEntry[] {
  return Object.entries(rec(map))
    .filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v))
    .map(([name, v]) => toServer(name, v, src))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The servers of an `.mcp.json`-style file: either `{ mcpServers: {…} }` or
 * the bare map. `[]` when the file is absent or malformed.
 */
export function readMcpJsonFile(path: string, src: Omit<McpSource, 'sourcePath'>): McpServerEntry[] {
  const parsed = rec(readJsonFile(path));
  const map = 'mcpServers' in parsed ? parsed.mcpServers : parsed;
  return mcpServersFrom(map, { ...src, sourcePath: path });
}
