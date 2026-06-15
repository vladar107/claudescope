/**
 * Memory landing (`/memory`) — a folder grid, one card per agent (connector)
 * that has any memory, mirroring the BrowsePage project-card look. Each card
 * drills into that agent's memory at `/memory/:connectorId`.
 *
 * Memory is read LIVE from the agent home dirs on the server (never indexed), so
 * this page just fetches and renders. Every store is usually absent/empty —
 * "no memory" is a normal, first-class state here, never an error.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MemoryResponse } from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, agentLabel, ErrorBox, Spinner } from '../../components';
import { isBenignError } from './shared.js';
import './memory.css';

/** Per-agent rollup driving one folder card on the landing page. */
interface AgentSummary {
  connectorId: string;
  label: string;
  /** Number of global user-authored instruction files. */
  globalFiles: number;
  /** Number of projects where this agent has any memory. */
  projectsWithFacts: number;
  /** Total facts this agent contributes across all projects. */
  totalFacts: number;
}

/**
 * Roll the global + project response into one summary per connector that has
 * any memory. A connector qualifies if it appears in `global` with sources, or
 * in any project's per-agent counts.
 */
function summarize(data: MemoryResponse): AgentSummary[] {
  const byId = new Map<string, AgentSummary>();

  const ensure = (connectorId: string, label: string): AgentSummary => {
    let s = byId.get(connectorId);
    if (!s) {
      s = { connectorId, label, globalFiles: 0, projectsWithFacts: 0, totalFacts: 0 };
      byId.set(connectorId, s);
    }
    return s;
  };

  for (const g of data.global) {
    if (g.sources.length === 0) continue;
    ensure(g.connectorId, g.label).globalFiles += g.sources.length;
  }

  for (const p of data.projects) {
    for (const c of p.counts) {
      if (c.count === 0) continue;
      const s = ensure(c.connectorId, agentLabel(c.connectorId));
      s.projectsWithFacts += 1;
      s.totalFacts += c.count;
    }
  }

  return [...byId.values()];
}

export function MemoryPage() {
  const [data, setData] = useState<MemoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .memory(controller.signal)
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isBenignError(err)) return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const agents = useMemo(() => (data ? summarize(data) : []), [data]);

  return (
    <div className="tv-memory">
      <h1 className="tv-page-title">Memory</h1>
      <p className="tv-memory__lede tv-muted">
        Long-lived instruction files and agent-distilled memory, read live from
        each agent&rsquo;s home directory. Pick an agent to browse its global
        memory and per-project facts.
      </p>

      {loading ? (
        <Spinner size="lg" label="Loading memory…" />
      ) : error ? (
        <ErrorBox error={error} title="Failed to load memory" onRetry={() => setReloadKey((k) => k + 1)} />
      ) : agents.length === 0 ? (
        <p className="tv-muted">No memory found yet.</p>
      ) : (
        <div className="tv-project-grid">
          {agents.map((a) => (
            <AgentMemoryCard key={a.connectorId} summary={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentMemoryCard({ summary }: { summary: AgentSummary }) {
  return (
    <Link to={`/memory/${encodeURIComponent(summary.connectorId)}`} className="tv-card tv-project-card">
      <div className="tv-memory-card__head">
        <AgentBadge connectorId={summary.connectorId} />
        <span className="tv-project-card__name">{summary.label}</span>
      </div>
      <div className="tv-project-card__stats">
        <span className="tv-chip">
          <span className="tv-chip__label">instruction files</span>
          <span className="tv-chip__value">{summary.globalFiles}</span>
        </span>
        <span className="tv-chip">
          <span className="tv-chip__label">projects</span>
          <span className="tv-chip__value">{summary.projectsWithFacts}</span>
        </span>
        <span className="tv-chip">
          <span className="tv-chip__label">facts</span>
          <span className="tv-chip__value">{summary.totalFacts}</span>
        </span>
      </div>
    </Link>
  );
}
