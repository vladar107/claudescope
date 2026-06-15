/**
 * The Memory tab of a project (`/projects/:projectId/memory`) — every agent's
 * memory for one project. The breadcrumb, name, and the Sessions | Memory tab
 * bar live in {@link ProjectLayout}; this renders just the tab body.
 *
 * Memory is read LIVE from the agent home dirs on the server (never indexed), so
 * this page just fetches and renders. "No memory" is a normal, first-class state
 * here, never an error.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ProjectMemoryResponse } from '@claudescope/shared';
import { api } from '../../api/client.js';
import { ErrorBox, Spinner } from '../../components';
import { ConnectorMemoryCard, isBenignError } from './shared.js';
import './memory.css';

export function ProjectMemoryPage() {
  const { projectId = '' } = useParams<{ projectId: string }>();

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

  const byAgent = (data?.byAgent ?? []).filter((a) => a.sources.length > 0);

  if (loading) return <Spinner size="lg" label="Loading memory…" />;
  if (error) {
    return <ErrorBox error={error} title="Failed to load memory" onRetry={() => setReloadKey((k) => k + 1)} />;
  }
  if (byAgent.length === 0) {
    return <p className="tv-muted">No memory found for this project yet.</p>;
  }

  return (
    <div className="tv-memory__connectors">
      {byAgent.map((a) => (
        <ConnectorMemoryCard
          key={a.connectorId}
          connectorId={a.connectorId}
          label={a.label}
          sources={a.sources}
        />
      ))}
    </div>
  );
}
