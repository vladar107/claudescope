/**
 * Live extensions collection (MCP servers, hooks, plugins) for the Extensions
 * page.
 *
 * Everything is read live from the agent home dirs (never indexed) via the
 * optional connector `mcpServers()` / `hooks()` / `plugins()` hooks. A kind an
 * agent has no hook for is `null` ("not supported"), distinct from `[]`
 * ("supported, nothing configured") — decided by method presence alone.
 * Connectors return already-redacted values with absolute paths; this module
 * only contracts the home dir and orders the lists.
 */

import type {
  AgentExtensions,
  ExtensionScope,
  ExtensionsResponse,
  InstalledHook,
  InstalledMcpServer,
  InstalledPlugin,
} from '@claudescope/shared';
import { connectors, detectedConnectors } from '../connectors/registry.js';
import type { AgentConnector } from '../connectors/types.js';
import { contractHome } from '../util/paths.js';

/** What one connector listed per kind; `null` where it lacks the hook. */
export interface ConnectorExtensions {
  connectorId: string;
  mcpServers: InstalledMcpServer[] | null;
  hooks: InstalledHook[] | null;
  plugins: InstalledPlugin[] | null;
}

/** The connector facts the rollup needs, so {@link buildExtensionsResponse} stays pure. */
export interface ExtensionsConnectorInfo {
  id: string;
  label: string;
}

const SCOPE_ORDER: Record<ExtensionScope, number> = { user: 0, project: 1, plugin: 2 };

const cmp = (a: string | undefined, b: string | undefined): number => (a ?? '').localeCompare(b ?? '');

/** Run one connector hook; a throw yields `[]` for that kind only. */
function safeList<T>(c: AgentConnector, kind: string, read: (() => T[]) | undefined): T[] | null {
  if (!read) return null;
  try {
    return read();
  } catch {
    // The error is deliberately not logged: config files can hold credentials.
    console.warn(`[extensions] ${c.id} ${kind} failed`);
    return [];
  }
}

/** Every connector with whatever extensions it currently sees. */
export function collectInstalledExtensions(): ConnectorExtensions[] {
  return connectors.map((c) => ({
    connectorId: c.id,
    mcpServers: safeList(c, 'mcpServers', c.mcpServers?.bind(c)),
    hooks: safeList(c, 'hooks', c.hooks?.bind(c)),
    plugins: safeList(c, 'plugins', c.plugins?.bind(c)),
  }));
}

function mcpSorted(list: InstalledMcpServer[]): InstalledMcpServer[] {
  return list
    .map((s) => ({
      ...s,
      sourcePath: contractHome(s.sourcePath),
      ...(s.project ? { project: contractHome(s.project) } : {}),
    }))
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || cmp(a.project, b.project) || cmp(a.name, b.name),
    );
}

function hooksSorted(list: InstalledHook[]): InstalledHook[] {
  return list
    .map((h) => ({ ...h, sourcePath: contractHome(h.sourcePath) }))
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
        cmp(a.event, b.event) ||
        cmp(a.matcher, b.matcher) ||
        cmp(a.command, b.command),
    );
}

function pluginsSorted(list: InstalledPlugin[]): InstalledPlugin[] {
  return list
    .map((p) => ({ ...p, sourcePath: contractHome(p.sourcePath) }))
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.marketplace, b.marketplace));
}

/**
 * Pure rollup: the detected connectors and what each listed → the response.
 * Agent order: agents with any item first, then supported-but-empty, then fully
 * unsupported; ties broken by label.
 */
export function buildExtensionsResponse(
  connectorInfos: ExtensionsConnectorInfo[],
  collected: ConnectorExtensions[],
): ExtensionsResponse {
  const byId = new Map(collected.map((c) => [c.connectorId, c]));
  const agents = connectorInfos.map((info): AgentExtensions => {
    const c = byId.get(info.id);
    return {
      connectorId: info.id,
      label: info.label,
      mcpServers: c?.mcpServers ? mcpSorted(c.mcpServers) : null,
      hooks: c?.hooks ? hooksSorted(c.hooks) : null,
      plugins: c?.plugins ? pluginsSorted(c.plugins) : null,
    };
  });

  const count = (a: AgentExtensions) =>
    (a.mcpServers?.length ?? 0) + (a.hooks?.length ?? 0) + (a.plugins?.length ?? 0);
  const supported = (a: AgentExtensions) => a.mcpServers !== null || a.hooks !== null || a.plugins !== null;
  const rank = (a: AgentExtensions) => (count(a) > 0 ? 0 : supported(a) ? 1 : 2);
  agents.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

  return { agents };
}

/** MCP servers, hooks and plugins across every detected agent. */
export function collectExtensions(): ExtensionsResponse {
  const collected = collectInstalledExtensions();
  // All three kinds are the agent's own config, so any entry is evidence it is installed.
  const infos = detectedConnectors(
    collected
      .filter((c) => (c.mcpServers?.length ?? 0) + (c.hooks?.length ?? 0) + (c.plugins?.length ?? 0) > 0)
      .map((c) => c.connectorId),
  ).map((c): ExtensionsConnectorInfo => ({ id: c.id, label: c.label }));
  return buildExtensionsResponse(infos, collected);
}
