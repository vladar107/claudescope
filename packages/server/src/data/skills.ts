/**
 * Live skills collection + usage attribution for the Skills page.
 *
 * Installed skills are read live from the agent home dirs (never indexed) via
 * the connector `skills()` hook; invocation figures come from the index
 * (`events.skill_names`: the `skill` argument of a canonical `Skill` call, or
 * the directory named by a `…/skills/<dir>/SKILL.md` read — see
 * `connectors/skill-names.ts`). The two are joined by (agent, name), trying the
 * skill's declared name first and its directory name second, since a read
 * names the directory — a plugin skill is `plugin:skill` in both. Usage is
 * attached ONLY for agents whose format records a load at all, so a skill an
 * agent cannot report on reads "unavailable" rather than 0.
 *
 * One install can be visible to several agents (a symlinked or shared
 * `~/.agents/skills` dir), so entries are deduped across connectors by
 * `realPath` into a `visibleTo` list rather than being merged away.
 */

import type {
  AgentSkills,
  InstalledSkill,
  SkillUsage,
  SkillsConnectorOverview,
  SkillsResponse,
  UnlocatedSkill,
} from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { connectors, detectedConnectors } from '../connectors/registry.js';
import type { AgentConnector, SkillEntry } from '../connectors/types.js';
import { contractHome } from '../util/paths.js';
import { toolCallRowsSql } from './analytics-metrics.js';
import {
  DEFAULT_CONNECTOR_ID,
  hasSkillInvocationSignal,
  skillUsageAvailabilityNote,
} from './agent-capabilities.js';

/** What one connector listed, tagged with the connector that listed it. */
export interface ConnectorSkillEntries {
  connectorId: string;
  entries: SkillEntry[];
}

/**
 * The connector facts the rollup needs, as a structural subset of
 * `AgentConnector` so {@link buildSkillsResponse} stays pure and testable
 * without a full connector implementation.
 */
export interface SkillsConnectorInfo {
  id: string;
  label: string;
  /** Whether the connector implements the `skills()` hook at all. */
  supported: boolean;
}

/** Invocation figures per agent, keyed by connector id then skill name. */
export type SkillUsageIndex = Map<string, Map<string, SkillUsage>>;

/** Per connector id: recorded directory name → the installed skill's name. */
export type SkillNameAliases = Map<string, Map<string, string>>;

/**
 * A read-based load records a skill's DIRECTORY name, and a plugin dir read
 * outside a recognisable plugin layout records it bare, while the install is
 * named `plugin:dir` (or by its frontmatter `name`). These aliases fold the
 * recorded name into the installed one, per agent, so the usage query and the
 * Analytics chart count one skill as one skill. A dir name that two installs
 * of the same agent share is ambiguous and is left alone.
 */
export function skillNameAliases(collected: ConnectorSkillEntries[]): SkillNameAliases {
  const out: SkillNameAliases = new Map();
  for (const { connectorId, entries } of collected) {
    const byDir = new Map<string, Set<string>>();
    for (const e of entries) {
      if (e.name === e.dirName) continue;
      (byDir.get(e.dirName) ?? byDir.set(e.dirName, new Set()).get(e.dirName)!).add(e.name);
    }
    const aliases = new Map<string, string>();
    for (const [dir, names] of byDir) if (names.size === 1) aliases.set(dir, [...names][0]!);
    if (aliases.size > 0) out.set(connectorId, aliases);
  }
  return out;
}

/**
 * A SQL expression folding a recorded skill name through {@link skillNameAliases}:
 * `CASE WHEN <agent>='x' AND <skill>='dir' THEN 'plugin:dir' … ELSE <skill> END`.
 * Literals go through `sqlString`; with no aliases it is just `<skill>`.
 */
export function skillNameFoldSql(agentExpr: string, skillExpr: string, aliases: SkillNameAliases): string {
  const arms: string[] = [];
  for (const [agent, byDir] of aliases) {
    for (const [dir, name] of byDir) {
      arms.push(`WHEN ${agentExpr} = ${sqlString(agent)} AND ${skillExpr} = ${sqlString(dir)} THEN ${sqlString(name)}`);
    }
  }
  return arms.length === 0 ? skillExpr : `CASE ${arms.join(' ')} ELSE ${skillExpr} END`;
}

function safeSkills(c: AgentConnector): SkillEntry[] {
  try {
    return c.skills?.() ?? [];
  } catch (err) {
    // Connector skill readers already return [] for absent dirs, so a throw here
    // is a genuine bug — warn so it doesn't masquerade as an empty Skills tab.
    console.warn(`[skills] ${c.id} skills failed:`, err);
    return [];
  }
}

/** Every connector that keeps a skills store, with the skills it currently sees. */
export function collectInstalledSkills(): ConnectorSkillEntries[] {
  return connectors
    .filter((c) => c.skills)
    .map((c) => ({ connectorId: c.id, entries: safeSkills(c) }));
}

/**
 * Invocation figures for every (agent, skill name) pair in the index. Counts
 * follow THE RULE for per-row aggregates (`toolCallRowsSql` — fork copies only,
 * never the usage election), exactly like /api/analytics/tools, so the two
 * cannot disagree. A row with no recorded `connector_id` is the default agent's.
 */
export async function loadSkillUsage(aliases: SkillNameAliases = new Map()): Promise<SkillUsageIndex> {
  const conn = await getConnection();
  const agent = `COALESCE(s.connector_id, ${sqlString(DEFAULT_CONNECTOR_ID)})`;
  const rows = await queryRows(
    conn,
    `SELECT ${agent} AS agent,
            ${skillNameFoldSql(agent, 't.skill', aliases)} AS skill,
            count(*) AS calls,
            count(DISTINCT t.session_id) AS sessions,
            strftime(max(t.ts), '%Y-%m-%dT%H:%M:%S.%gZ') AS last_used
     FROM (
       SELECT unnest(string_split(e.skill_names, ',')) AS skill, e.session_id, e.ts
       FROM events e
       WHERE e.type = 'assistant' AND ${toolCallRowsSql()} AND e.skill_names <> ''
     ) t
     JOIN sessions s ON t.session_id = s.id
     WHERE t.skill <> ''
     GROUP BY 1, 2`,
  );

  const index: SkillUsageIndex = new Map();
  for (const r of rows) {
    const rd = readRow(r, 'skills-usage');
    const agent = rd.str('agent');
    const lastUsedAt = rd.str('last_used');
    let byName = index.get(agent);
    if (!byName) {
      byName = new Map();
      index.set(agent, byName);
    }
    byName.set(rd.str('skill'), {
      calls: rd.num('calls'),
      sessions: rd.num('sessions'),
      ...(lastUsedAt ? { lastUsedAt } : {}),
    });
  }
  return index;
}

/** Map a connector entry to the API shape, contracting the home dir for display. */
function toInstalled(entry: SkillEntry, visibleTo: string[], usage?: SkillUsage): InstalledSkill {
  const sourcePath = contractHome(entry.path);
  // `realPath` is only interesting when the install is reached through a
  // symlink — otherwise it restates `sourcePath`.
  const realPath = entry.realPath !== entry.path ? contractHome(entry.realPath) : undefined;
  return {
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    origin: entry.origin,
    ...(entry.plugin ? { plugin: entry.plugin } : {}),
    sourcePath,
    ...(realPath ? { realPath } : {}),
    updatedAt: entry.updatedAt,
    visibleTo,
    ...(usage ? { usage } : {}),
  };
}

/** Connector ids that list a given resolved install, so `visibleTo` can name the others. */
function agentsByRealPath(collected: ConnectorSkillEntries[]): Map<string, Set<string>> {
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

/** One agent's skills: installed (usage attached when the agent reports it) + unlocated. */
function buildAgentSkills(
  info: SkillsConnectorInfo,
  entries: SkillEntry[],
  byRealPath: Map<string, Set<string>>,
  usage: SkillUsageIndex,
): AgentSkills {
  const usageSignal = hasSkillInvocationSignal(info.id);
  const note = skillUsageAvailabilityNote(info.id);
  const byName = usage.get(info.id);

  // Two of this agent's dirs can resolve to one install (opencode reads
  // `~/.claude/skills` AND `~/.agents/skills`, which may be the same symlink
  // target) — the first-listed dir wins, so the origin stays the primary one.
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    if (seen.has(entry.realPath)) return false;
    seen.add(entry.realPath);
    return true;
  });

  // A native call names the skill as declared; a SKILL.md read names its
  // directory. Both keys belong to the same install, so their figures add up.
  const usageFor = (entry: SkillEntry): SkillUsage | undefined => {
    if (!usageSignal) return undefined;
    const keys = entry.dirName === entry.name ? [entry.name] : [entry.name, entry.dirName];
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

  const skills = unique
    .map((entry) => {
      const visibleTo = [...(byRealPath.get(entry.realPath) ?? [])]
        .filter((id) => id !== info.id)
        .sort();
      return toInstalled(entry, visibleTo, usageFor(entry));
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // A name the transcripts show invoked but no install of THIS agent carries:
  // project-scoped, or removed since. Only knowable where usage is knowable.
  const installedNames = new Set(unique.flatMap((e) => [e.name, e.dirName]));
  const unlocated: UnlocatedSkill[] = usageSignal
    ? [...(byName?.entries() ?? [])]
        .filter(([name]) => !installedNames.has(name))
        .map(([name, u]) => ({ name, usage: u }))
        .sort((a, b) => b.usage.calls - a.usage.calls || a.name.localeCompare(b.name))
    : [];

  return {
    connectorId: info.id,
    label: info.label,
    usageSignal,
    ...(note ? { usageNote: note } : {}),
    skills,
    unlocated,
  };
}

/** Roll one agent's skills up into its landing card. */
function toOverview(info: SkillsConnectorInfo, agent: AgentSkills): SkillsConnectorOverview {
  const installed = agent.skills.length;
  const used = agent.skills.filter((s) => (s.usage?.calls ?? 0) > 0).length;

  // Latest by mtime; deterministic tie-break on name so a stable skill wins.
  const latest = agent.skills.reduce<InstalledSkill | undefined>((best, s) => {
    if (!best) return s;
    if (s.updatedAt > best.updatedAt) return s;
    if (s.updatedAt === best.updatedAt && s.name < best.name) return s;
    return best;
  }, undefined);

  return {
    connectorId: info.id,
    label: info.label,
    supported: info.supported,
    usageSignal: agent.usageSignal,
    installed,
    used,
    neverUsed: agent.usageSignal ? installed - used : 0,
    unlocated: agent.unlocated.length,
    ...(latest
      ? {
          preview: {
            name: latest.name,
            ...(latest.description ? { description: latest.description } : {}),
          },
        }
      : {}),
  };
}

/**
 * Pure rollup: the detected connectors, what each listed, and the index's usage
 * → the Skills response. `connectorInfos` carries every agent detected on this
 * machine (including those that keep no skills store, as `supported: false`);
 * `agents` holds one entry per SUPPORTED connector, empty ones included, so the
 * page can show an installed-but-empty store as such.
 *
 * Card order mirrors the memory page: supported-with-skills first, then
 * supported-empty, then unsupported; ties broken by label.
 */
export function buildSkillsResponse(
  connectorInfos: SkillsConnectorInfo[],
  collected: ConnectorSkillEntries[],
  usage: SkillUsageIndex,
): SkillsResponse {
  const byRealPath = agentsByRealPath(collected);
  const entriesById = new Map(collected.map((c) => [c.connectorId, c.entries]));

  const byConnector = new Map<string, AgentSkills>();
  const overviews: SkillsConnectorOverview[] = [];
  for (const info of connectorInfos) {
    const agent = buildAgentSkills(info, entriesById.get(info.id) ?? [], byRealPath, usage);
    byConnector.set(info.id, agent);
    overviews.push(toOverview(info, agent));
  }

  const rank = (o: SkillsConnectorOverview) =>
    o.supported && o.installed > 0 ? 0 : o.supported ? 1 : 2;
  overviews.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

  // `agents` follows the card order, so the page's sections match its cards.
  const agents = overviews
    .filter((o) => o.supported)
    .map((o) => byConnector.get(o.connectorId))
    .filter((a): a is AgentSkills => a !== undefined);

  return { connectors: overviews, agents };
}

/** Installed skills across every detected agent, joined with indexed usage. */
export async function collectSkills(): Promise<SkillsResponse> {
  const collected = collectInstalledSkills();
  const usage = await loadSkillUsage(skillNameAliases(collected));
  // Only an agent's OWN store is evidence it is installed: a connector that
  // also reads a shared dir or another agent's dir (opencode reads
  // `~/.claude/skills`) must not gain a card on a machine that never ran it.
  const infos = detectedConnectors(
    collected
      .filter((c) => c.entries.some((e) => e.origin !== 'shared'))
      .map((c) => c.connectorId),
  ).map((c): SkillsConnectorInfo => ({ id: c.id, label: c.label, supported: Boolean(c.skills) }));
  return buildSkillsResponse(infos, collected, usage);
}
