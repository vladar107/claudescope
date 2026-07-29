/**
 * Live memory collection + attribution, shared by the memory and search routes.
 *
 * Memory is read live from the agent home dirs (never indexed). A connector's
 * per-project memory dir is keyed by the git repo root, so one dir may hold facts
 * learned across several worktrees/cwds. We attach each fact to the project of
 * its `originSessionId` (resolved against the index), falling back to the project
 * that owns the dir (its encoded-cwd slug). This makes a worktree project surface
 * the facts that were actually learned in it.
 */

import type { MemoryConnectorOverview, MemoryPreview, MemorySource } from '@claudescope/shared';
import { getConnection, queryRows } from '../db/duckdb.js';
import { connectors } from '../connectors/registry.js';
import type { AgentConnector } from '../connectors/types.js';
import { displayNameFromCwd, projectIdFromCwd } from './project-id.js';
import { memorySlugForCwd } from '../connectors/claude-code/memory.js';

/** One memory source, attributed to a connector and (for project facts) a project. */
export interface AttributedMemory {
  connectorId: string;
  label: string;
  scope: 'global' | 'project';
  /** Project facts only. */
  projectId?: string;
  projectDisplayName?: string;
  source: MemorySource;
}

function safeGlobal(c: AgentConnector): MemorySource[] {
  try {
    return c.globalMemory?.() ?? [];
  } catch (err) {
    // Connector memory readers already return [] for absent files, so a throw
    // here is a genuine bug — warn so it doesn't masquerade as an empty Memory tab.
    console.warn(`[memory] ${c.id} globalMemory failed:`, err);
    return [];
  }
}

function safeProject(c: AgentConnector) {
  try {
    return c.projectMemory?.() ?? [];
  } catch (err) {
    console.warn(`[memory] ${c.id} projectMemory failed:`, err);
    return [];
  }
}

/**
 * Every memory source across all connectors: global instruction files/handbooks
 * plus per-project facts attributed to a Claudescope project. Facts whose origin
 * session isn't indexed and whose dir slug matches no project are dropped.
 */
export async function collectMemory(): Promise<AttributedMemory[]> {
  const out: AttributedMemory[] = [];

  for (const c of connectors) {
    for (const source of safeGlobal(c)) {
      out.push({ connectorId: c.id, label: c.label, scope: 'global', source });
    }
  }

  const conn = await getConnection();
  // The derived `sessions` table exposes the session id as `id`.
  const rows = await queryRows(
    conn,
    'SELECT id, project_cwd FROM sessions WHERE project_cwd IS NOT NULL',
  );

  const sessionToProject = new Map<string, string>();
  const slugToProject = new Map<string, string>();
  const displayNames = new Map<string, string>();
  for (const r of rows) {
    const cwd = String(r.project_cwd);
    const projectId = projectIdFromCwd(cwd);
    if (r.id != null) sessionToProject.set(String(r.id), projectId);
    const slug = memorySlugForCwd(cwd);
    if (!slugToProject.has(slug)) slugToProject.set(slug, projectId);
    if (!displayNames.has(projectId)) displayNames.set(projectId, displayNameFromCwd(cwd));
  }

  for (const c of connectors) {
    for (const dir of safeProject(c)) {
      const fallback = slugToProject.get(dir.slug);
      for (const source of dir.facts) {
        const byOrigin = source.originSessionId
          ? sessionToProject.get(source.originSessionId)
          : undefined;
        const projectId = byOrigin ?? fallback;
        if (!projectId) continue;
        out.push({
          connectorId: c.id,
          label: c.label,
          scope: 'project',
          projectId,
          projectDisplayName: displayNames.get(projectId),
          source,
        });
      }
    }
  }

  return out;
}

/**
 * Whether a connector exposes a memory provider at all. Derived from the
 * connector port: a memory store exists iff the connector implements
 * `globalMemory` and/or `projectMemory`. Connectors with neither (pi, opencode)
 * keep no memory store, so their card is marked `supported: false`.
 */
function hasMemoryProvider(c: AgentConnector): boolean {
  return Boolean(c.globalMemory || c.projectMemory);
}

/**
 * Collapse a markdown body to a short single-line excerpt for the preview.
 * Strips a leading `---` frontmatter block, common inline/structural markdown
 * (headings, list/quote markers, emphasis, links, inline code), collapses all
 * whitespace, and truncates to ~140 chars with an ellipsis. Deterministic.
 */
function excerptFromMarkdown(markdown: string): string {
  let body = markdown;
  // Drop a leading YAML frontmatter block (`---` … `---`).
  const fm = body.match(/^---\n[\s\S]*?\n---\n?/);
  if (fm) body = body.slice(fm[0].length);
  const text = body
    .replace(/`+/g, '') // inline/fenced code ticks
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images → their text
    .replace(/^\s*[#>\-*+]+\s*/gm, '') // headings, quotes, list markers
    .replace(/[*_~]/g, '') // emphasis markers
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
}

/** Map a memory source to a one-line preview, deriving the excerpt when needed. */
function toPreview(it: AttributedMemory): MemoryPreview {
  const { source } = it;
  const description = source.description?.trim() || excerptFromMarkdown(source.markdown) || undefined;
  return {
    title: source.title,
    ...(source.category ? { category: source.category } : {}),
    ...(description ? { description } : {}),
    provenance: source.provenance,
    kind: source.kind,
    scope: it.scope,
  };
}

/**
 * Roll up {@link collectMemory} items into one {@link MemoryConnectorOverview}
 * per supplied connector. The route supplies the connectors detected on the
 * current machine, including detected agents with no memory store.
 *
 * Counts mirror the web's prior `summarize()`: `globalFiles` = the connector's
 * global sources; `projectsWithFacts` = distinct projects with ≥1 of its
 * sources; `totalFacts` = total project sources. `preview` is the connector's
 * most-recently-updated source (by `source.updatedAt`) across BOTH global and
 * project items, omitted when it has none. Sort: supported-with-content first,
 * then supported-empty, then unsupported; ties broken by label.
 */
export function buildConnectorOverviews(
  items: AttributedMemory[],
  visibleConnectors: AgentConnector[],
): MemoryConnectorOverview[] {
  const byConnector = new Map<string, AttributedMemory[]>();
  for (const it of items) {
    const list = byConnector.get(it.connectorId);
    if (list) list.push(it);
    else byConnector.set(it.connectorId, [it]);
  }

  const overviews = visibleConnectors.map((c): MemoryConnectorOverview => {
    const mine = byConnector.get(c.id) ?? [];
    const globalFiles = mine.filter((it) => it.scope === 'global').length;
    const projectItems = mine.filter((it) => it.scope === 'project');
    const projectsWithFacts = new Set(projectItems.map((it) => it.projectId)).size;

    // Latest by mtime across all scopes; deterministic tie-break on title so a
    // stable item wins when two share an `updatedAt`.
    const latest = mine.reduce<AttributedMemory | undefined>((best, it) => {
      if (!best) return it;
      if (it.source.updatedAt > best.source.updatedAt) return it;
      if (it.source.updatedAt === best.source.updatedAt && it.source.title < best.source.title) return it;
      return best;
    }, undefined);

    return {
      connectorId: c.id,
      label: c.label,
      supported: hasMemoryProvider(c),
      globalFiles,
      projectsWithFacts,
      totalFacts: projectItems.length,
      ...(latest ? { preview: toPreview(latest) } : {}),
    };
  });

  // Supported-with-content first, then supported-empty, then unsupported.
  const rank = (o: MemoryConnectorOverview) =>
    o.supported && o.preview ? 0 : o.supported ? 1 : 2;
  return overviews.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}
