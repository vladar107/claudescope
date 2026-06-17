/**
 * Memory routes — surface each connector's live (NOT indexed) memory.
 *
 *   - GET /api/memory                       → global memory per connector, a
 *                                             per-project summary of which agents
 *                                             have any project memory, and a
 *                                             per-connector overview (counts +
 *                                             content preview) for the landing
 *                                             cards — including agents that keep
 *                                             no memory store (`supported: false`).
 *   - GET /api/projects/:projectId/memory   → per-agent memory for one project.
 *
 * Attribution (origin-session → project, dir slug fallback) lives in
 * `data/memory.ts` and is shared with search. Every store is usually
 * absent/empty, so "no memory" is a normal state.
 */

import type { FastifyInstance } from 'fastify';
import type { GlobalMemory, MemoryResponse, MemorySource, ProjectMemoryResponse } from '@claudescope/shared';
import { buildConnectorOverviews, collectMemory, type AttributedMemory } from '../data/memory.js';

/** Group attributed memory by `projectId` then `connectorId`. */
function projectBuckets(items: AttributedMemory[]) {
  const buckets = new Map<string, Map<string, { label: string; sources: MemorySource[] }>>();
  const displayNames = new Map<string, string>();
  for (const it of items) {
    if (it.scope !== 'project' || !it.projectId) continue;
    if (it.projectDisplayName) displayNames.set(it.projectId, it.projectDisplayName);
    let byConnector = buckets.get(it.projectId);
    if (!byConnector) {
      byConnector = new Map();
      buckets.set(it.projectId, byConnector);
    }
    let bucket = byConnector.get(it.connectorId);
    if (!bucket) {
      bucket = { label: it.label, sources: [] };
      byConnector.set(it.connectorId, bucket);
    }
    bucket.sources.push(it.source);
  }
  return { buckets, displayNames };
}

export async function registerMemoryRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/memory', async (): Promise<MemoryResponse> => {
    const items = await collectMemory();

    // Global memory grouped per connector (first occurrence sets the label).
    const globalByConnector = new Map<string, GlobalMemory>();
    for (const it of items) {
      if (it.scope !== 'global') continue;
      let g = globalByConnector.get(it.connectorId);
      if (!g) {
        g = { connectorId: it.connectorId, label: it.label, sources: [] };
        globalByConnector.set(it.connectorId, g);
      }
      g.sources.push(it.source);
    }

    const { buckets, displayNames } = projectBuckets(items);
    const projects = [...buckets.entries()]
      .map(([projectId, byConnector]) => {
        const counts = [...byConnector.entries()].map(([connectorId, b]) => ({
          connectorId,
          count: b.sources.length,
        }));
        const total = counts.reduce((n, c) => n + c.count, 0);
        return { projectId, displayName: displayNames.get(projectId) ?? projectId, counts, total };
      })
      .sort((a, b) => b.total - a.total || a.displayName.localeCompare(b.displayName))
      .map(({ projectId, displayName, counts }) => ({ projectId, displayName, counts }));

    return { global: [...globalByConnector.values()], projects, connectors: buildConnectorOverviews(items) };
  });

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/memory',
    async (req): Promise<ProjectMemoryResponse> => {
      const { projectId } = req.params;
      const { buckets, displayNames } = projectBuckets(await collectMemory());
      const byConnector = buckets.get(projectId);
      const byAgent = byConnector
        ? [...byConnector.entries()].map(([connectorId, b]) => ({
            connectorId,
            label: b.label,
            sources: b.sources,
          }))
        : [];
      const displayName = displayNames.get(projectId);
      return { projectId, ...(displayName ? { displayName } : {}), byAgent };
    },
  );
}
