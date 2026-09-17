/**
 * One agent's skill inventory (`/skills/:connectorId`) — every skill it can
 * load, where that install lives, which other agents read the very same one,
 * and how often it was actually invoked.
 *
 * Skills are read LIVE from the agent home dirs on the server (never indexed),
 * so this page just fetches and renders. Usage comes from the index: when the
 * agent's format records no skill invocation (`usageSignal: false`) every cell
 * reads "n/a" with the reason in its tooltip — never a fabricated 0.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { AgentSkills, InstalledSkill, SkillsResponse } from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, agentLabel, ErrorBox, formatCount, Spinner } from '../../components';
import { formatDate, formatDateTime } from '../browse/format.js';
import { isBenignError } from '../memory/shared.js';
import './skills.css';

/** Columns the table can be sorted by (name is the default). */
type SortKey = 'name' | 'uses' | 'lastUsed';

interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** Sortable value for a skill; absent usage always sinks to the bottom. */
function sortValue(s: InstalledSkill, key: SortKey): number {
  if (key === 'uses') return s.usage?.calls ?? -1;
  const iso = s.usage?.lastUsedAt;
  if (!iso) return -1;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? -1 : ms;
}

export function AgentSkillsPage() {
  const { connectorId = '' } = useParams<{ connectorId: string }>();

  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .skills(controller.signal)
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
  const agent: AgentSkills | undefined = useMemo(
    () => data?.agents.find((a) => a.connectorId === connectorId),
    [data, connectorId],
  );

  const skills = useMemo(() => {
    const rows = [...(agent?.skills ?? [])];
    const byName = (a: InstalledSkill, b: InstalledSkill) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (sort.key === 'name') {
      rows.sort((a, b) => (sort.dir === 'asc' ? byName(a, b) : byName(b, a)));
      return rows;
    }
    rows.sort((a, b) => {
      const delta = sortValue(a, sort.key) - sortValue(b, sort.key);
      if (delta !== 0) return sort.dir === 'asc' ? delta : -delta;
      return byName(a, b);
    });
    return rows;
  }, [agent, sort]);

  // Numeric columns read best highest-first, so their first click sorts desc.
  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'name' ? 'asc' : 'desc' },
    );

  const usageSignal = agent?.usageSignal ?? false;
  const naTitle = agent?.usageNote ?? "This agent's format records no skill invocation";
  const hasAnything = (agent?.skills.length ?? 0) > 0 || (agent?.unlocated.length ?? 0) > 0;

  return (
    <section className="tv-skills">
      <div className="tv-browse__crumbs">
        <Link to="/skills" className="tv-linkbtn">
          ← Skills
        </Link>
      </div>

      <header className="tv-skills__head">
        <AgentBadge connectorId={connectorId} />
        <h1 className="tv-page-title" style={{ marginBottom: 0 }}>
          {label}
        </h1>
      </header>

      {agent?.usageNote ? <p className="tv-skills__note tv-muted">{agent.usageNote}</p> : null}

      {loading ? (
        <Spinner size="lg" label="Loading skills…" />
      ) : error ? (
        <ErrorBox error={error} title="Failed to load skills" onRetry={() => setReloadKey((k) => k + 1)} />
      ) : !agent || !hasAnything ? (
        <p className="tv-muted">No skills found for this agent yet.</p>
      ) : (
        <>
          {skills.length > 0 ? (
            <div className="tv-skills__scroll">
              <table className="tv-skills__table">
                <thead>
                  <tr>
                    <SortHeader label="Skill" sortKey="name" sort={sort} onSort={onSort} />
                    <th>Origin</th>
                    <th>Location</th>
                    <th>Visible to</th>
                    <SortHeader
                      label="Uses"
                      sortKey="uses"
                      sort={sort}
                      onSort={onSort}
                      className="tv-skills__num"
                    />
                    <SortHeader
                      label="Last used"
                      sortKey="lastUsed"
                      sort={sort}
                      onSort={onSort}
                      className="tv-skills__num"
                    />
                  </tr>
                </thead>
                <tbody>
                  {skills.map((s) => (
                    <tr key={`${s.sourcePath}:${s.name}`} className="tv-skills__row">
                      <td className="tv-skills__skill">
                        <span className="tv-skills__name">{s.name}</span>
                        {s.description ? (
                          <span className="tv-skills__desc tv-muted">{s.description}</span>
                        ) : null}
                      </td>
                      <td>
                        <OriginChip skill={s} />
                      </td>
                      <td className="tv-skills__loc">
                        <span className="tv-mono" title={s.sourcePath}>
                          {s.sourcePath}
                        </span>
                        {s.realPath ? (
                          <span
                            className="tv-mono tv-skills__real tv-muted"
                            title={`Symlink target: ${s.realPath}`}
                          >
                            → {s.realPath}
                          </span>
                        ) : null}
                      </td>
                      <td className="tv-skills__visible">
                        {s.visibleTo.length > 0 ? (
                          s.visibleTo.map((id) => <AgentBadge key={id} connectorId={id} />)
                        ) : (
                          <span className="tv-muted">—</span>
                        )}
                      </td>
                      <td className="tv-skills__num">
                        {!usageSignal ? (
                          <span className="tv-skills__na" title={naTitle}>
                            n/a
                          </span>
                        ) : s.usage ? (
                          <>
                            {formatCount(s.usage.calls)}{' '}
                            <span className="tv-muted">
                              · {formatCount(s.usage.sessions)} session
                              {s.usage.sessions === 1 ? '' : 's'}
                            </span>
                          </>
                        ) : (
                          <span className="tv-muted">never</span>
                        )}
                      </td>
                      <td className="tv-skills__num">
                        {s.usage?.lastUsedAt ? (
                          <span title={formatDateTime(s.usage.lastUsedAt)}>
                            {formatDate(s.usage.lastUsedAt)}
                          </span>
                        ) : (
                          <span className="tv-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="tv-muted">No skills installed in this agent&rsquo;s home directory.</p>
          )}

          {agent.unlocated.length > 0 ? (
            <section className="tv-skills__section">
              <h2 className="tv-skills__section-title">Used but not installed globally</h2>
              <p className="tv-skills__note tv-muted">
                Loaded in transcripts, but not found in this agent&rsquo;s home directory —
                installed at repository level, or removed since.
              </p>
              <div className="tv-skills__scroll">
                <table className="tv-skills__table">
                  <thead>
                    <tr>
                      <th>Skill</th>
                      <th className="tv-skills__num">Calls</th>
                      <th className="tv-skills__num">Sessions</th>
                      <th className="tv-skills__num">Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agent.unlocated.map((u) => (
                      <tr key={u.name} className="tv-skills__row">
                        <td>
                          <span className="tv-skills__name">{u.name}</span>
                        </td>
                        <td className="tv-skills__num">{formatCount(u.usage.calls)}</td>
                        <td className="tv-skills__num">{formatCount(u.usage.sessions)}</td>
                        <td className="tv-skills__num">
                          {u.usage.lastUsedAt ? (
                            <span title={formatDateTime(u.usage.lastUsedAt)}>
                              {formatDate(u.usage.lastUsedAt)}
                            </span>
                          ) : (
                            <span className="tv-muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Where the skill comes from — a plugin shows the plugin name, details on hover. */
function OriginChip({ skill }: { skill: InstalledSkill }) {
  if (skill.origin === 'plugin' && skill.plugin) {
    const { name, marketplace, version } = skill.plugin;
    const detail = [marketplace, version ? `v${version}` : undefined].filter(Boolean).join(' · ');
    return (
      <span className="tv-chip tv-skills__origin" title={detail ? `Plugin ${name} — ${detail}` : `Plugin ${name}`}>
        {name}
      </span>
    );
  }
  return <span className="tv-chip tv-skills__origin">{skill.origin}</span>;
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th className={className} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={active ? 'tv-skills__sort is-active' : 'tv-skills__sort'}
        aria-pressed={active}
        onClick={() => onSort(sortKey)}
      >
        {label}
        {active ? (
          <span className="tv-skills__car" aria-hidden="true">
            {sort.dir === 'asc' ? '↑' : '↓'}
          </span>
        ) : null}
      </button>
    </th>
  );
}
