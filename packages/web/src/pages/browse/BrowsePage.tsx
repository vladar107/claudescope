import { useEffect, useMemo, useState } from 'react';
import type { ProjectMeta } from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { AgentBadge, CostBadge, ErrorBox, Spinner, TokenChips } from '../../components';
import { timeAgo } from './format.js';
import { SessionList } from './SessionList.js';
import './browse.css';

type ProjectSort = 'recent' | 'sessions' | 'tokens' | 'cost' | 'name';

const PROJECT_SORTS: { value: ProjectSort; label: string }[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'sessions', label: 'Most sessions' },
  { value: 'tokens', label: 'Most tokens' },
  { value: 'cost', label: 'Highest cost' },
  { value: 'name', label: 'Name (A–Z)' },
];

/** Sort projects client-side (the projects endpoint returns the full list). */
function sortProjects(projects: ProjectMeta[], sort: ProjectSort): ProjectMeta[] {
  const copy = [...projects];
  switch (sort) {
    case 'recent':
      return copy.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
    case 'sessions':
      return copy.sort((a, b) => b.sessionCount - a.sessionCount);
    case 'tokens':
      return copy.sort((a, b) => b.totalTokens - a.totalTokens);
    case 'cost':
      return copy.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
    case 'name':
      return copy.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}

/**
 * Browse view. Top level lists all projects; selecting one drills into its
 * sessions via {@link SessionList}. Selection is kept in component state so the
 * back button restores the project grid without a refetch.
 */
export function BrowsePage() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<ProjectMeta | null>(null);
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [filter, setFilter] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .listProjects(controller.signal)
      .then((data) => {
        setProjects(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.status === 0) return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = q
      ? projects.filter(
          (p) => p.displayName.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q),
        )
      : projects;
    return sortProjects(base, sort);
  }, [projects, filter, sort]);

  if (selected) {
    return <SessionList project={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <section>
      <header className="tv-browse__header">
        <h1 className="tv-page-title" style={{ marginBottom: 0 }}>
          Projects
        </h1>
        <div className="tv-browse__controls">
          <input
            className="tv-input"
            type="search"
            placeholder="Filter projects…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            className="tv-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as ProjectSort)}
            aria-label="Sort projects"
          >
            {PROJECT_SORTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      {loading ? (
        <Spinner size="lg" label="Loading projects…" />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : visible.length === 0 ? (
        <p className="tv-muted">
          {projects.length === 0 ? 'No projects indexed yet.' : 'No projects match the filter.'}
        </p>
      ) : (
        <div className="tv-project-grid">
          {visible.map((p) => (
            <ProjectCard key={p.id} project={p} onOpen={() => setSelected(p)} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectCard({ project, onOpen }: { project: ProjectMeta; onOpen: () => void }) {
  return (
    <button type="button" className="tv-card tv-project-card" onClick={onOpen}>
      <div className="tv-project-card__name">{project.displayName}</div>
      <div className="tv-project-card__cwd tv-muted tv-mono">{project.cwd}</div>
      <div className="tv-project-card__stats">
        {project.connectorIds.map((id) => (
          <AgentBadge key={id} connectorId={id} />
        ))}
        <span className="tv-chip">
          <span className="tv-chip__label">sessions</span>
          <span className="tv-chip__value">{project.sessionCount}</span>
        </span>
        <TokenChips totalOnly total={project.totalTokens} />
        <CostBadge usd={project.totalCostUsd} />
      </div>
      <div className="tv-project-card__footer tv-muted">{timeAgo(project.lastActive)}</div>
    </button>
  );
}
