/**
 * One agent's memory for one project (`/memory/:connectorId/:projectId`) — the
 * facts a single agent has distilled for a single project. Reached by drilling
 * from the per-agent page (`/memory/:connectorId`).
 *
 * Memory is read LIVE from the agent home dirs on the server (never indexed), so
 * this page just fetches and renders. "No memory" is a normal, first-class state
 * here, never an error.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ProjectMemoryResponse } from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, agentLabel, ErrorBox, Spinner } from '../../components';
import { MemorySourceCard } from './MemorySourceCard.js';
import { collectNames, isBenignError } from './shared.js';
import './memory.css';

export function AgentProjectMemoryPage() {
  const { connectorId = '', projectId = '' } = useParams<{
    connectorId: string;
    projectId: string;
  }>();

  const [data, setData] = useState<ProjectMemoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .projectMemory(projectId, controller.signal)
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
  }, [projectId, reloadKey]);

  const label = agentLabel(connectorId);

  const agent = useMemo(
    () => data?.byAgent.find((a) => a.connectorId === connectorId) ?? null,
    [data, connectorId],
  );
  const sources = agent?.sources ?? [];
  const knownNames = useMemo(() => collectNames(sources), [sources]);

  return (
    <section className="tv-memory">
      <div className="tv-browse__crumbs">
        <Link to="/memory" className="tv-linkbtn">
          ← Memory
        </Link>
        <span className="tv-muted"> / </span>
        <Link to={`/memory/${encodeURIComponent(connectorId)}`} className="tv-linkbtn">
          {label}
        </Link>
        <span className="tv-muted"> / </span>
        <span className="tv-mono">{data?.displayName ?? projectId}</span>
      </div>

      <header className="tv-memory-connector__head">
        <AgentBadge connectorId={connectorId} />
        <h1 className="tv-page-title" style={{ marginBottom: 0 }}>
          {label} memory
        </h1>
      </header>

      {loading ? (
        <Spinner size="lg" label="Loading memory…" />
      ) : error ? (
        <ErrorBox error={error} title="Failed to load memory" onRetry={() => setReloadKey((k) => k + 1)} />
      ) : sources.length === 0 ? (
        <p className="tv-muted">No memory found for this agent in this project yet.</p>
      ) : (
        <div className="tv-memory-group__items">
          {sources.map((s) => (
            <MemorySourceCard key={s.sourcePath} source={s} knownNames={knownNames} />
          ))}
        </div>
      )}
    </section>
  );
}
