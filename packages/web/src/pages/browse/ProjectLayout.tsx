/**
 * Shared chrome for a single project (`/projects/:projectId` and its `/memory`
 * child). Owns the breadcrumb, project name + cwd, and the Sessions | Memory tab
 * bar; the active tab's body renders through `<Outlet>`.
 *
 * Because the header and the project-meta fetch live here (not in each tab),
 * switching Sessions ↔ Memory swaps only the body — the header stays put and the
 * project list isn't refetched, so the transition reads as a panel switch rather
 * than a full page load.
 */

import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom';
import type { ProjectMeta } from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { formatCost, formatCount, SummaryStrip } from '../../components';
import { useDataVersionRefetch } from '../../status/useDataVersionRefetch.js';
import '../memory/memory.css';

export interface ProjectOutletContext {
  projectId: string;
  /** Project meta (name, cwd, per-agent breakdown); null while loading or unknown. */
  project: ProjectMeta | null;
}

/** Tab children read the shared project meta via this hook. */
export function useProjectContext(): ProjectOutletContext {
  return useOutletContext<ProjectOutletContext>();
}

/** Ignore aborted/offline fetch errors that are not user-actionable. */
function isBenignError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof ApiError && err.status === 0) return true;
  return false;
}

const tabClass = ({ isActive }: { isActive: boolean }): string =>
  isActive ? 'tv-memory-tabs__tab is-active' : 'tv-memory-tabs__tab';

export function ProjectLayout() {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectMeta | null>(null);

  // Project meta is fetched once for the whole project view; tab switches reuse it.
  useEffect(() => {
    const controller = new AbortController();
    api
      .listProjects(controller.signal)
      .then((projects) => setProject(projects.find((p) => p.id === projectId) ?? null))
      .catch((err: unknown) => {
        if (!isBenignError(err)) console.warn('Failed to load project meta', err);
      });
    return () => controller.abort();
  }, [projectId]);

  // Keep the header stats (sessions/tokens/cost) in step with the session list
  // below, which silently refetches when a reindex pass lands new data.
  useDataVersionRefetch((signal) => {
    api
      .listProjects(signal)
      .then((projects) => setProject(projects.find((p) => p.id === projectId) ?? null))
      .catch(() => {
        /* transient — the next change retries */
      });
  });

  const displayName = project?.displayName ?? projectId;

  return (
    <section>
      <div className="tv-browse__crumbs">
        <Link to="/" className="tv-linkbtn">
          ← Projects
        </Link>
        <span className="tv-muted"> / </span>
        <span className="tv-mono">{displayName}</span>
      </div>

      <header className="tv-browse__header">
        <div>
          <h1 className="tv-page-title" style={{ marginBottom: 4 }}>
            {displayName}
          </h1>
          {project ? (
            <div className="tv-muted tv-mono" style={{ fontSize: 'var(--tv-fs-sm)' }}>
              {project.cwd}
            </div>
          ) : null}
        </div>
        {project ? (
          <SummaryStrip
            items={[
              { label: 'Sessions', value: formatCount(project.sessionCount) },
              { label: 'Tokens', value: formatCount(project.totalTokens) },
              { label: 'Cost', value: formatCost(project.totalCostUsd) },
              { label: 'Agents', value: formatCount(project.connectorIds.length) },
            ]}
          />
        ) : null}
      </header>

      <div className="tv-memory-tabs" role="tablist" aria-label="Project view">
        <NavLink to={`/projects/${encodeURIComponent(projectId)}`} end className={tabClass} role="tab">
          Sessions
        </NavLink>
        <NavLink
          to={`/projects/${encodeURIComponent(projectId)}/memory`}
          className={tabClass}
          role="tab"
        >
          Memory
        </NavLink>
      </div>

      <Outlet context={{ projectId, project }} />
    </section>
  );
}
