/**
 * Live subagent-definition collection + usage attribution for the Subagents
 * kind of the Extensions page.
 *
 * Definitions are read live from the agent home dirs (never indexed) via the
 * connector `subagents()` hook; spawn figures come from the index
 * (`events.subagent_names`: the `subagent_type` of a canonical `Task`/`Agent`
 * call — see `connectors/subagent-names.ts`). The two are joined by
 * (agent, name), trying the definition's name first and its aliases (file
 * stem, a plugin agent's unprefixed name) after, since which one a spawn
 * records is a guess for several layouts. Usage is attached ONLY for agents
 * whose format names the spawned subagent at all, so a definition an agent
 * cannot report on reads "unavailable" rather than 0.
 *
 * One definition can be visible to several agents (a symlinked or shared dir),
 * so entries are deduped across connectors by `realPath` into a `visibleTo`
 * list rather than being merged away.
 */

import type {
  AgentSubagents,
  InstalledSubagent,
  SkillUsage,
  SubagentsConnectorOverview,
  SubagentsResponse,
  UnlocatedSubagent,
} from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { connectors, detectedConnectors } from '../connectors/registry.js';
import type { AgentConnector, SubagentEntry } from '../connectors/types.js';
import { contractHome } from '../util/paths.js';
import { toolCallRowsSql } from './analytics-metrics.js';
import {
  DEFAULT_CONNECTOR_ID,
  hasSubagentInvocationSignal,
  subagentUsageAvailabilityNote,
} from './agent-capabilities.js';

/** What one connector listed, tagged with the connector that listed it. */
export interface ConnectorSubagentEntries {
  connectorId: string;
  entries: SubagentEntry[];
}

/**
 * The connector facts the rollup needs, as a structural subset of
 * `AgentConnector` so {@link buildSubagentsResponse} stays pure and testable
 * without a full connector implementation.
 */
export interface SubagentsConnectorInfo {
  id: string;
  label: string;
  /** Whether the connector implements the `subagents()` hook at all. */
  supported: boolean;
}

/** Spawn figures per agent, keyed by connector id then recorded subagent name. */
export type SubagentUsageIndex = Map<string, Map<string, SkillUsage>>;

function safeSubagents(c: AgentConnector): SubagentEntry[] {
  try {
    return c.subagents?.() ?? [];
  } catch (err) {
    // Readers already return [] for absent dirs, so a throw here is a genuine
    // bug — warn so it doesn't masquerade as an empty Subagents tab.
    console.warn(`[subagents] ${c.id} subagents failed:`, err);
    return [];
  }
}

/** Every connector that keeps subagent definitions, with the ones it currently sees. */
export function collectInstalledSubagents(): ConnectorSubagentEntries[] {
  return connectors
    .filter((c) => c.subagents)
    .map((c) => ({ connectorId: c.id, entries: safeSubagents(c) }));
}

/**
 * Spawn figures for every (agent, subagent name) pair in the index. Counts
 * follow THE RULE for per-row aggregates (`toolCallRowsSql` — fork copies only,
 * never the usage election), exactly like skill usage, so the two cannot
 * disagree. A row with no recorded `connector_id` is the default agent's.
 */
export async function loadSubagentUsage(): Promise<SubagentUsageIndex> {
  const conn = await getConnection();
  const rows = await queryRows(
    conn,
    `SELECT COALESCE(s.connector_id, ${sqlString(DEFAULT_CONNECTOR_ID)}) AS agent,
            t.subagent,
            count(*) AS calls,
            count(DISTINCT t.session_id) AS sessions,
            strftime(max(t.ts), '%Y-%m-%dT%H:%M:%S.%gZ') AS last_used
     FROM (
       SELECT unnest(string_split(e.subagent_names, ',')) AS subagent, e.session_id, e.ts
       FROM events e
       WHERE e.type = 'assistant' AND ${toolCallRowsSql()} AND e.subagent_names <> ''
     ) t
     JOIN sessions s ON t.session_id = s.id
     WHERE t.subagent <> ''
     GROUP BY 1, 2`,
  );

  const index: SubagentUsageIndex = new Map();
  for (const r of rows) {
    const rd = readRow(r, 'subagents-usage');
    const agent = rd.str('agent');
    const lastUsedAt = rd.str('last_used');
    let byName = index.get(agent);
    if (!byName) {
      byName = new Map();
      index.set(agent, byName);
    }
    byName.set(rd.str('subagent'), {
      calls: rd.num('calls'),
      sessions: rd.num('sessions'),
      ...(lastUsedAt ? { lastUsedAt } : {}),
    });
  }
  return index;
}

/** Map a connector entry to the API shape, contracting the home dir for display. */
function toInstalled(entry: SubagentEntry, visibleTo: string[], usage?: SkillUsage): InstalledSubagent {
  const sourcePath = contractHome(entry.path);
  // `realPath` is only interesting when the definition is reached through a
  // symlink — otherwise it restates `sourcePath`.
  const realPath = entry.realPath !== entry.path ? contractHome(entry.realPath) : undefined;
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    origin: entry.origin,
    ...(entry.plugin ? { plugin: entry.plugin } : {}),
    sourcePath,
    ...(realPath ? { realPath } : {}),
    updatedAt: entry.updatedAt,
    visibleTo,
    ...(usage ? { usage } : {}),
  };
}

/** Connector ids that list a given resolved definition, so `visibleTo` can name the others. */
function agentsByRealPath(collected: ConnectorSubagentEntries[]): Map<string, Set<string>> {
  const byRealPath = new Map<string, Set<string>>();
  for (const { connectorId, entries } of collected) {
    for (const entry of entries) {
      let ids = byRealPath.get(entry.realPath);
      if (!ids) {
        ids = new Set();
        byRealPath.set(entry.realPath, ids);
      }
      ids.add(connectorId);
    }
  }
  return byRealPath;
}

/**
 * The names a spawn of `entry` may be recorded under: its own name, then every
 * alias not in `reserved` — another definition's primary name (a plugin
 * agent's unprefixed alias `reviewer` must not claim the spawns of a user
 * agent actually named `reviewer`), or an alias two definitions share. Such a
 * spawn lands in unlocated rather than being counted twice.
 */
function usageKeys(entry: SubagentEntry, reserved: Set<string>): string[] {
  const keys = [entry.name];
  for (const alias of entry.aliases) {
    if (keys.includes(alias) || reserved.has(alias)) continue;
    keys.push(alias);
  }
  return keys;
}

/** One agent's subagents: definitions (usage attached when the agent reports it) + unlocated. */
function buildAgentSubagents(
  info: SubagentsConnectorInfo,
  entries: SubagentEntry[],
  byRealPath: Map<string, Set<string>>,
  usage: SubagentUsageIndex,
): AgentSubagents {
  const usageSignal = hasSubagentInvocationSignal(info.id);
  const note = subagentUsageAvailabilityNote(info.id);
  const byName = usage.get(info.id);

  // Two of this agent's dirs can resolve to one definition — the first-listed
  // dir wins, so the origin stays the primary one.
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    if (seen.has(entry.realPath)) return false;
    seen.add(entry.realPath);
    return true;
  });
  const reserved = new Set(unique.map((e) => e.name));
  const aliasSeen = new Set<string>();
  for (const e of unique) {
    for (const alias of new Set(e.aliases)) {
      if (aliasSeen.has(alias)) reserved.add(alias);
      aliasSeen.add(alias);
    }
  }

  // Every key belongs to the same definition, so their figures add up.
  const usageFor = (keys: string[]): SkillUsage | undefined => {
    if (!usageSignal) return undefined;
    const hits = keys.map((k) => byName?.get(k)).filter((u): u is SkillUsage => u !== undefined);
    if (hits.length === 0) return undefined;
    if (hits.length === 1) return hits[0];
    const lastUsedAt = hits.map((u) => u.lastUsedAt).filter((t): t is string => !!t).sort().at(-1);
    return {
      calls: hits.reduce((n, u) => n + u.calls, 0),
      sessions: hits.reduce((n, u) => n + u.sessions, 0),
      ...(lastUsedAt ? { lastUsedAt } : {}),
    };
  };

  const definedNames = new Set<string>();
  const subagents = unique
    .map((entry) => {
      const keys = usageKeys(entry, reserved);
      for (const k of keys) definedNames.add(k);
      const visibleTo = [...(byRealPath.get(entry.realPath) ?? [])]
        .filter((id) => id !== info.id)
        .sort();
      return toInstalled(entry, visibleTo, usageFor(keys));
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // A name the transcripts show spawned but no definition of THIS agent
  // carries: a built-in, project-level, or removed since. Only knowable where
  // usage is knowable.
  const unlocated: UnlocatedSubagent[] = usageSignal
    ? [...(byName?.entries() ?? [])]
        .filter(([name]) => !definedNames.has(name))
        .map(([name, u]) => ({ name, usage: u }))
        .sort((a, b) => b.usage.calls - a.usage.calls || a.name.localeCompare(b.name))
    : [];

  return {
    connectorId: info.id,
    label: info.label,
    usageSignal,
    ...(note ? { usageNote: note } : {}),
    subagents,
    unlocated,
  };
}

/** Roll one agent's subagents up into its landing card. */
function toOverview(info: SubagentsConnectorInfo, agent: AgentSubagents): SubagentsConnectorOverview {
  const installed = agent.subagents.length;
  const used = agent.subagents.filter((s) => (s.usage?.calls ?? 0) > 0).length;

  return {
    connectorId: info.id,
    label: info.label,
    supported: info.supported,
    usageSignal: agent.usageSignal,
    installed,
    used,
    neverUsed: agent.usageSignal ? installed - used : 0,
    unlocated: agent.unlocated.length,
  };
}

/**
 * Pure rollup: the detected connectors, what each listed, and the index's usage
 * → the Subagents response. `connectorInfos` carries every agent detected on
 * this machine (including those with no definitions format, as
 * `supported: false`); `agents` holds one entry per SUPPORTED connector, empty
 * ones included, so the page can show an agent with no definitions as such.
 *
 * Card order mirrors the skills page: supported-with-definitions first, then
 * supported-empty, then unsupported; ties broken by label.
 */
export function buildSubagentsResponse(
  connectorInfos: SubagentsConnectorInfo[],
  collected: ConnectorSubagentEntries[],
  usage: SubagentUsageIndex,
): SubagentsResponse {
  const byRealPath = agentsByRealPath(collected);
  const entriesById = new Map(collected.map((c) => [c.connectorId, c.entries]));

  const byConnector = new Map<string, AgentSubagents>();
  const overviews: SubagentsConnectorOverview[] = [];
  for (const info of connectorInfos) {
    const agent = buildAgentSubagents(info, entriesById.get(info.id) ?? [], byRealPath, usage);
    byConnector.set(info.id, agent);
    overviews.push(toOverview(info, agent));
  }

  const rank = (o: SubagentsConnectorOverview) =>
    o.supported && o.installed > 0 ? 0 : o.supported ? 1 : 2;
  overviews.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

  // `agents` follows the card order, so the page's sections match its cards.
  const agents = overviews
    .filter((o) => o.supported)
    .map((o) => byConnector.get(o.connectorId))
    .filter((a): a is AgentSubagents => a !== undefined);

  return { connectors: overviews, agents };
}

/** Subagent definitions across every detected agent, joined with indexed usage. */
export async function collectSubagents(): Promise<SubagentsResponse> {
  const collected = collectInstalledSubagents();
  const usage = await loadSubagentUsage();
  // Only an agent's OWN store is evidence it is installed: a definition read
  // from a shared dir must not give a card to an agent this machine never ran.
  const infos = detectedConnectors(
    collected
      .filter((c) => c.entries.some((e) => e.origin !== 'shared'))
      .map((c) => c.connectorId),
  ).map((c): SubagentsConnectorInfo => ({ id: c.id, label: c.label, supported: Boolean(c.subagents) }));
  return buildSubagentsResponse(infos, collected, usage);
}
