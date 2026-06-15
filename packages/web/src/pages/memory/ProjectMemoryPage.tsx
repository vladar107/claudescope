/**
 * Per-project memory (`/projects/:projectId/memory`) — every agent's memory for
 * one project, reached from that project's Sessions | Memory tab bar.
 *
 * Renders the same tab bar {@link SessionListPage} uses (Memory active, Sessions
 * linking back to `/projects/:projectId`), so back-navigation returns to the
 * project's sessions rather than to the global Memory landing.
 *
 * Memory is read LIVE from the agent home dirs on the server (never indexed), so
 * this page just fetches and renders. "No memory" is a normal, first-class state
 * here, never an error.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
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

  return (
    <section className="tv-memory">
      <div className="tv-browse__crumbs">
        <Link to="/" className="tv-linkbtn">
          ← Projects
        </Link>
      </div>

      <h1 className="tv-page-title">Project memory</h1>

      {/* Sessions | Memory tab bar — Memory active; Sessions returns to this
          project's session list (not the global Memory landing). */}
      <div className="tv-memory-tabs" role="tablist" aria-label="Project view">
        <Link
          to={`/projects/${encodeURIComponent(projectId)}`}
          className="tv-memory-tabs__tab"
          role="tab"
          aria-selected="false"
        >
          Sessions
        </Link>
        <span className="tv-memory-tabs__tab is-active" role="tab" aria-selected="true">
          Memory
        </span>
      </div>

      {loading ? (
        <Spinner size="lg" label="Loading memory…" />
      ) : error ? (
        <ErrorBox error={error} title="Failed to load memory" onRetry={() => setReloadKey((k) => k + 1)} />
      ) : byAgent.length === 0 ? (
        <p className="tv-muted">No memory found for this project yet.</p>
      ) : (
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
      )}
    </section>
  );
}
