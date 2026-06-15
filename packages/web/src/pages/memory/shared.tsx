/**
 * Shared helpers and presentation pieces for the Memory area pages
 * (`/memory`, `/memory/:connectorId`, `/memory/:connectorId/:projectId`,
 * `/projects/:projectId/memory`).
 *
 * Memory is read LIVE from the agent home dirs on the server (never indexed), so
 * the pages just fetch and render. Every store is usually absent/empty — "no
 * memory" is a normal, first-class state here, never an error.
 */

import { useMemo } from 'react';
import type { MemorySource } from '@claudescope/shared';
import { ApiError } from '../../api/client.js';
import { AgentBadge } from '../../components';
import { MemorySourceCard } from './MemorySourceCard.js';

/** Ignore aborted/offline fetch errors that are not user-actionable. */
export function isBenignError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof ApiError && err.status === 0) return true;
  return false;
}

/** Names of facts in a set of sources, for in-view `[[wiki-link]]` resolution. */
export function collectNames(sources: MemorySource[]): Set<string> {
  return new Set(sources.map((s) => s.title));
}

interface CategoryGroup {
  category?: string;
  sources: MemorySource[];
}

/**
 * Group sources by `category`, preserving first-seen order. Sources without a
 * category collapse into one trailing group (rendered without a subtitle). When
 * nothing is categorised, returns a single uncategorised group.
 */
export function groupByCategory(sources: MemorySource[]): CategoryGroup[] {
  const order: string[] = [];
  const byCategory = new Map<string, MemorySource[]>();
  const uncategorised: MemorySource[] = [];

  for (const s of sources) {
    if (!s.category) {
      uncategorised.push(s);
      continue;
    }
    if (!byCategory.has(s.category)) {
      byCategory.set(s.category, []);
      order.push(s.category);
    }
    byCategory.get(s.category)!.push(s);
  }

  const groups: CategoryGroup[] = order.map((category) => ({
    category,
    sources: byCategory.get(category)!,
  }));
  if (uncategorised.length > 0) groups.push({ sources: uncategorised });
  return groups;
}

/**
 * One agent's memory card: a header with the agent badge, then its sources
 * visually separated into user-authored instruction files and agent-distilled
 * memory. Agent-authored Claude facts are grouped by category when present.
 */
export function ConnectorMemoryCard({
  connectorId,
  label,
  sources,
}: {
  connectorId: string;
  label: string;
  sources: MemorySource[];
}) {
  // Resolve `[[wiki-links]]` against every fact this connector contributes.
  const knownNames = useMemo(() => collectNames(sources), [sources]);

  const userAuthored = sources.filter((s) => s.provenance === 'user-authored');
  const agentAuthored = sources.filter((s) => s.provenance === 'agent-authored');

  // Group agent-authored sources by category (Claude facts); uncategorised
  // sources fall under a single trailing bucket.
  const agentGroups = useMemo(() => groupByCategory(agentAuthored), [agentAuthored]);

  return (
    <section className="tv-memory-connector">
      <header className="tv-memory-connector__head">
        <AgentBadge connectorId={connectorId} />
        <span className="tv-memory-connector__label">{label}</span>
      </header>

      {userAuthored.length > 0 ? (
        <div className="tv-memory-group">
          <h3 className="tv-memory-group__title">Instruction files</h3>
          <div className="tv-memory-group__items">
            {userAuthored.map((s) => (
              <MemorySourceCard key={s.sourcePath} source={s} knownNames={knownNames} />
            ))}
          </div>
        </div>
      ) : null}

      {agentAuthored.length > 0 ? (
        <div className="tv-memory-group">
          <h3 className="tv-memory-group__title">Agent memory</h3>
          {agentGroups.map((group) => (
            <div key={group.category ?? '__none'} className="tv-memory-group__items">
              {group.category ? (
                <h4 className="tv-memory-group__subtitle">{group.category}</h4>
              ) : null}
              {group.sources.map((s) => (
                <MemorySourceCard key={s.sourcePath} source={s} knownNames={knownNames} />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
