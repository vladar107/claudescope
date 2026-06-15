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

import type { MemorySource } from '@claudescope/shared';
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
  } catch {
    return [];
  }
}

function safeProject(c: AgentConnector) {
  try {
    return c.projectMemory?.() ?? [];
  } catch {
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
