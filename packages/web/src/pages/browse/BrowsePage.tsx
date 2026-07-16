import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProjectMeta, SourceInfo } from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { AgentBadge, ErrorBox, formatCost, formatCount, SearchField, Spinner, SummaryStrip } from '../../components';
import { useServerStatus } from '../../status/StatusProvider.js';
import { useDataVersionRefetch } from '../../status/useDataVersionRefetch.js';
import { timeAgo } from './format.js';
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
 * Browse view. Lists all projects; each card links to `/projects/:id` (the
 * routed session list), so drill-down is URL-driven and deep-linkable.
 */
/** Min interval between silent project refetches while the index builds. */
const REFETCH_THROTTLE_MS = 2000;

export function BrowsePage() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [sort, setSort] = useState<ProjectSort>('recent');
  const [filter, setFilter] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const { ready, indexing, building, indexingTick } = useServerStatus();

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

  // While the index builds, silently refetch projects so cards appear as
  // sessions get indexed (no setLoading — no spinner flash), plus one final
  // refetch when building flips off to catch the last finalization.
  const wasBuilding = useRef(false);
  const lastRefetch = useRef(0);
  useEffect(() => {
    const buildEnded = wasBuilding.current && !building;
    wasBuilding.current = building;
    if (!building && !buildEnded) return;
    if (building && Date.now() - lastRefetch.current < REFETCH_THROTTLE_MS) return;
    lastRefetch.current = Date.now();
    const controller = new AbortController();
    api
      .listProjects(controller.signal)
      .then((data) => {
        setProjects(data);
        setLoading(false);
      })
      .catch(() => {
        /* transient — the next tick retries */
      });
    return () => controller.abort();
  }, [building, indexingTick]);

  // Steady-state freshness: silently refetch when a reindex pass lands new
  // data, so project cards update without a manual reload.
  useDataVersionRefetch((signal) => {
    api
      .listProjects(signal)
      .then(setProjects)
      .catch(() => {
        /* transient — the next change retries */
      });
  });

  // The genuinely-empty state (ready, idle, zero projects) explains itself with
  // the watched source directories; fetch them lazily only when it shows.
  const genuinelyEmpty =
    !building && ready === true && !loading && !error && projects.length === 0;
  useEffect(() => {
    if (!genuinelyEmpty || sources !== null) return;
    const controller = new AbortController();
    api
      .sources(controller.signal)
      .then(setSources)
      .catch(() => {
        /* best-effort — the fallback copy still renders */
      });
    return () => controller.abort();
  }, [genuinelyEmpty, sources]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = q
      ? projects.filter(
          (p) => p.displayName.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q),
        )
      : projects;
    return sortProjects(base, sort);
  }, [projects, filter, sort]);

  // Portfolio totals — computed over ALL projects (not the filtered view) so the
  // summary stays a stable anchor regardless of the filter box.
  const portfolio = useMemo(() => {
    const agents = new Set<string>();
    let sessions = 0;
    let cost = 0;
    for (const p of projects) {
      p.connectorIds.forEach((id) => agents.add(id));
      sessions += p.sessionCount;
      cost += p.totalCostUsd;
    }
    return { projects: projects.length, sessions, cost, agents: agents.size };
  }, [projects]);

  const indexingLabel = indexing
    ? indexing.processed < indexing.total
      ? `Indexing ${indexing.processed} of ${indexing.total} transcripts…`
      : 'Finishing up the index…'
    : 'Building the transcript index…';

  return (
    <section>
      <header className="tv-browse__header">
        <h1 className="tv-page-title" style={{ marginBottom: 0 }}>
          Projects
        </h1>
        <div className="tv-browse__controls">
          <SearchField
            value={filter}
            onChange={setFilter}
            placeholder="Filter projects…"
            ariaLabel="Filter projects"
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

      {!loading && !error && projects.length > 0 ? (
        <SummaryStrip
          items={[
            { label: 'Projects', value: formatCount(portfolio.projects) },
            { label: 'Sessions', value: formatCount(portfolio.sessions) },
            { label: 'Spend', value: formatCost(portfolio.cost) },
            { label: 'Agents', value: formatCount(portfolio.agents) },
          ]}
        />
      ) : null}

      {loading ? (
        <Spinner size="lg" label="Loading projects…" />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : visible.length === 0 ? (
        projects.length > 0 ? (
          <p className="tv-muted">No projects match the filter.</p>
        ) : building ? (
          // First build (or a post-update rebuild) in progress and nothing
          // indexed yet — show live progress instead of a misleading empty state.
          <Spinner size="lg" label={indexingLabel} />
        ) : ready === true ? (
          <EmptyIndexNotice sources={sources} />
        ) : (
          <p className="tv-muted">No projects indexed yet.</p>
        )
      ) : (
        <>
          {building ? (
            <div className="tv-browse__indexing tv-muted">
              <Spinner label={indexingLabel} />
            </div>
          ) : null}
          <div className="tv-project-grid">
            {visible.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Ready + idle + zero projects: explain whether any source dirs exist at all. */
function EmptyIndexNotice({ sources }: { sources: SourceInfo[] | null }) {
  if (sources === null) return <p className="tv-muted">No projects indexed yet.</p>;
  if (sources.length === 0) {
    return <p className="tv-muted">No agent transcript directories were found on this machine.</p>;
  }
  return (
    <div className="tv-muted tv-browse__empty">
      <p>No transcripts found yet. Watching:</p>
      <ul className="tv-browse__sources">
        {sources.map((s) => (
          <li key={s.id}>
            <span className="tv-mono">{s.path}</span> — {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectMeta }) {
  return (
    <Link to={`/projects/${project.id}`} className="tv-card tv-project-card">
      <div className="tv-project-card__top">
        <div className="tv-project-card__name">{project.displayName}</div>
        <span className="tv-project-card__time tv-muted">{timeAgo(project.lastActive)}</span>
      </div>
      <div className="tv-project-card__cwd tv-muted tv-mono">{project.cwd}</div>
      {/* Agents (badges) read at a glance; the numbers live in their own muted
          meta line below so the two stop competing. */}
      <div className="tv-project-card__agents">
        {project.connectorIds.map((id) => (
          <AgentBadge key={id} connectorId={id} />
        ))}
      </div>
      <div className="tv-project-card__meta tv-muted">
        <span>
          {project.sessionCount} session{project.sessionCount === 1 ? '' : 's'}
        </span>
        <span>·</span>
        <span>{formatCount(project.totalTokens)} tokens</span>
        <span>·</span>
        <span className="tv-project-card__cost">{formatCost(project.totalCostUsd)}</span>
      </div>
    </Link>
  );
}
