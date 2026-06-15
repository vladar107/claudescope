/**
 * One agent's memory (`/memory/:connectorId`) — its global user-authored
 * instruction files and agent-distilled memory, plus the projects where this
 * agent has any memory, each drilling into `/memory/:connectorId/:projectId`.
 *
 * Memory is read LIVE from the agent home dirs on the server (never indexed), so
 * this page just fetches and renders. "No memory" is a normal, first-class state
 * here, never an error.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { MemoryResponse, MemorySource } from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, agentLabel, ErrorBox, Spinner } from '../../components';
import { MemorySourceCard } from './MemorySourceCard.js';
import { collectNames, isBenignError } from './shared.js';
import './memory.css';

/** A project where this connector has memory, with its fact count. */
interface ProjectEntry {
  projectId: string;
  displayName: string;
  count: number;
}

export function AgentMemoryPage() {
  const { connectorId = '' } = useParams<{ connectorId: string }>();

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

  const label = agentLabel(connectorId);

  // This connector's global sources.
  const globalSources: MemorySource[] = useMemo(
    () => data?.global.find((g) => g.connectorId === connectorId)?.sources ?? [],
    [data, connectorId],
  );
  const knownNames = useMemo(() => collectNames(globalSources), [globalSources]);

  // Projects where this connector contributes any memory.
  const projects: ProjectEntry[] = useMemo(() => {
    if (!data) return [];
    return data.projects
      .map((p) => {
        const count = p.counts.find((c) => c.connectorId === connectorId)?.count ?? 0;
        return { projectId: p.projectId, displayName: p.displayName, count };
      })
      .filter((p) => p.count > 0);
  }, [data, connectorId]);

  const hasGlobal = globalSources.length > 0;
  const hasProjects = projects.length > 0;

  return (
    <section className="tv-memory">
      <div className="tv-browse__crumbs">
        <Link to="/memory" className="tv-linkbtn">
          ← Memory
        </Link>
      </div>

      <header className="tv-memory-connector__head">
        <AgentBadge connectorId={connectorId} />
        <h1 className="tv-page-title" style={{ marginBottom: 0 }}>
          {label}
        </h1>
      </header>

      {loading ? (
        <Spinner size="lg" label="Loading memory…" />
      ) : error ? (
        <ErrorBox error={error} title="Failed to load memory" onRetry={() => setReloadKey((k) => k + 1)} />
      ) : !hasGlobal && !hasProjects ? (
        <p className="tv-muted">No memory found for this agent yet.</p>
      ) : (
        <>
          {hasGlobal ? (
            <section className="tv-memory__section">
              <h2 className="tv-memory__section-title">Global memory</h2>
              <div className="tv-memory-group__items">
                {globalSources.map((s) => (
                  <MemorySourceCard key={s.sourcePath} source={s} knownNames={knownNames} />
                ))}
              </div>
            </section>
          ) : null}

          {hasProjects ? (
            <section className="tv-memory__section">
              <h2 className="tv-memory__section-title">Project memory</h2>
              <ul className="tv-list">
                {projects.map((p) => (
                  <li key={p.projectId} className="tv-card tv-memory__project">
                    <Link
                      to={`/memory/${encodeURIComponent(connectorId)}/${encodeURIComponent(p.projectId)}`}
                      className="tv-memory__project-main"
                    >
                      <span className="tv-memory__project-name">{p.displayName}</span>
                      <span className="tv-chip tv-memory__project-count">
                        <span className="tv-chip__label">facts</span>
                        <span className="tv-memory__project-count-n">{p.count}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
