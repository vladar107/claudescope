/**
 * One agent's extension inventory (`/extensions/:connectorId`) — its skills
 * (where each install lives, which other agents read the very same one, and how
 * often it was invoked), MCP servers, hooks, and plugins, one tab each; the
 * open tab is kept in `?tab=` so links can point at it.
 *
 * Everything is read LIVE from the agent home dirs on the server (never
 * indexed), so this page just fetches and renders. Skill usage comes from the
 * index: when the agent's format records no skill invocation
 * (`usageSignal: false`) every cell reads "n/a" with the reason in its tooltip
 * — never a fabricated 0. For MCP servers, hooks, and plugins a `null` list
 * means the agent has no such concept ("not supported"); `[]` means supported
 * but nothing configured. Values arrive pre-redacted and render as given.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type {
  AgentExtensions,
  AgentSkills,
  ExtensionsResponse,
  InstalledHook,
  InstalledMcpServer,
  InstalledPlugin,
  InstalledSkill,
  SkillsResponse,
} from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, agentLabel, ErrorBox, formatCount, Spinner } from '../../components';
import { formatDate, formatDateTime } from '../browse/format.js';
import { isBenignError } from '../memory/shared.js';
import './extensions.css';

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

export function AgentExtensionsPage() {
  const { connectorId = '' } = useParams<{ connectorId: string }>();

  const [data, setData] = useState<SkillsResponse | null>(null);
  const [extData, setExtData] = useState<ExtensionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([api.skills(controller.signal), api.extensions(controller.signal)])
      .then(([res, ext]) => {
        setData(res);
        setExtData(ext);
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

  const ext: AgentExtensions | undefined = useMemo(
    () => extData?.agents.find((a) => a.connectorId === connectorId),
    [extData, connectorId],
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
  const mcpServers = ext?.mcpServers ?? null;
  const hooks = ext?.hooks ?? null;
  const plugins = ext?.plugins ?? null;
  const skillCount = agent?.skills.length ?? 0;
  const lists = { mcp: mcpServers, hooks, plugins };

  // The open tab lives in the URL (`?tab=mcp`) so a link can point at it;
  // switching replaces the entry instead of stacking history.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const selectTab = (t: Tab) => setSearchParams(t === 'skills' ? {} : { tab: t }, { replace: true });

  return (
    <section className="tv-skills">
      <div className="tv-browse__crumbs">
        <Link to="/extensions" className="tv-linkbtn">
          ← Extensions
        </Link>
      </div>

      <header className="tv-skills__head">
        <AgentBadge connectorId={connectorId} />
        <h1 className="tv-page-title" style={{ marginBottom: 0 }}>
          {label}
        </h1>
      </header>

      {loading ? (
        <Spinner size="lg" label="Loading extensions…" />
      ) : error ? (
        <ErrorBox
          error={error}
          title="Failed to load extensions"
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : !agent && !ext ? (
        <p className="tv-muted">No extensions found for this agent yet.</p>
      ) : (
        <>
          <div className="tv-ext__tabs" role="tablist" aria-label="Extension kinds">
            {TABS.map((t) => {
              const count = t.id === 'skills' ? (agent ? skillCount : null) : (lists[t.id]?.length ?? null);
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  className={tab === t.id ? 'tv-tab is-active' : 'tv-tab'}
                  onClick={() => selectTab(t.id)}
                >
                  {t.label} {count !== null ? <span className="tv-tab__count">{count}</span> : null}
                </button>
              );
            })}
          </div>

          {tab === 'skills' ? (
            <section
              id="panel-skills"
              role="tabpanel"
              aria-labelledby="tab-skills"
              className="tv-skills__section"
            >
              {agent?.usageNote ? <p className="tv-skills__note tv-muted">{agent.usageNote}</p> : null}
              {!agent ? (
                <p className="tv-muted">{label} loads no skills from its home directory.</p>
              ) : skills.length > 0 ? (
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

              {agent && agent.unlocated.length > 0 ? (
                <section className="tv-skills__section">
                  <h2 className="tv-skills__section-title">Used but not installed globally</h2>
                  <p className="tv-skills__note tv-muted">
                    Loaded in transcripts, but not found in this agent&rsquo;s home directory — installed at
                    repository level, or removed since.
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
            </section>
          ) : null}

          {tab === 'mcp' ? (
            <ExtPanel id="mcp" noun="MCP servers" label={label} items={mcpServers}>
              {(rows) => <McpTable rows={rows} />}
            </ExtPanel>
          ) : null}
          {tab === 'hooks' ? (
            <ExtPanel id="hooks" noun="hooks" label={label} items={hooks}>
              {(rows) => <HooksTable rows={rows} />}
            </ExtPanel>
          ) : null}
          {tab === 'plugins' ? (
            <ExtPanel id="plugins" noun="plugins" label={label} items={plugins}>
              {(rows) => <PluginsTable rows={rows} />}
            </ExtPanel>
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
      <span
        className="tv-chip tv-skills__origin"
        title={detail ? `Plugin ${name} — ${detail}` : `Plugin ${name}`}
      >
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

type Tab = 'skills' | 'mcp' | 'hooks' | 'plugins';

const TABS: { id: Tab; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'plugins', label: 'Plugins' },
];

function parseTab(raw: string | null): Tab {
  return TABS.find((t) => t.id === raw)?.id ?? 'skills';
}

/** Tab panel: the table, an "unsupported" note (`null`), or an empty note. */
function ExtPanel<T>({
  id,
  noun,
  label,
  items,
  children,
}: {
  id: Tab;
  noun: string;
  label: string;
  items: T[] | null;
  children: (rows: T[]) => ReactNode;
}) {
  return (
    <section id={`panel-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} className="tv-skills__section">
      {items === null ? (
        <p className="tv-muted">
          {label} doesn&rsquo;t support {noun}.
        </p>
      ) : items.length === 0 ? (
        <p className="tv-muted">None configured in {label}&rsquo;s global config.</p>
      ) : (
        <div className="tv-skills__scroll">{children(items)}</div>
      )}
    </section>
  );
}

const DISABLED_CHIP = (
  <span className="tv-chip tv-ext__chip" title="Disabled in the agent's config">
    disabled
  </span>
);

/** Long text ellipsized in the cell, full text on hover. */
function Clip({ text }: { text: string }) {
  return (
    <span className="tv-mono tv-ext__clip" title={text}>
      {text}
    </span>
  );
}

function ScopeChip({
  scope,
  project,
  plugin,
}: {
  scope: string;
  project?: string;
  plugin?: { name: string };
}) {
  if (scope === 'project') {
    return (
      <span className="tv-chip tv-ext__chip" title={project}>
        project
      </span>
    );
  }
  if (scope === 'plugin') {
    return <span className="tv-chip tv-ext__chip">plugin: {plugin?.name ?? '?'}</span>;
  }
  return null;
}

function McpTable({ rows }: { rows: InstalledMcpServer[] }) {
  return (
    <table className="tv-skills__table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Transport</th>
          <th>Launch</th>
          <th>Env / headers</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m, i) => {
          const launch = m.url ?? [m.command, ...(m.args ?? [])].filter(Boolean).join(' ');
          const keys = [
            ...(m.envKeys ?? []).map((k) => `env: ${k}`),
            ...(m.headerKeys ?? []).map((k) => `header: ${k}`),
          ];
          return (
            <tr
              key={`${m.sourcePath}:${m.scope}:${m.project ?? ''}:${m.name}:${i}`}
              className="tv-skills__row"
            >
              <td className="tv-ext__name-cell">
                <span className="tv-skills__name">{m.name}</span>
                {m.enabled === false ? DISABLED_CHIP : null}
                <ScopeChip scope={m.scope} project={m.project} plugin={m.plugin} />
              </td>
              <td>{m.transport}</td>
              <td>{launch ? <Clip text={launch} /> : <span className="tv-muted">—</span>}</td>
              <td className="tv-ext__chips">
                {keys.length > 0 ? (
                  keys.map((k) => (
                    <span key={k} className="tv-chip tv-ext__chip tv-mono">
                      {k}
                    </span>
                  ))
                ) : (
                  <span className="tv-muted">—</span>
                )}
              </td>
              <td className="tv-skills__loc">
                <span className="tv-mono tv-muted" title={m.sourcePath}>
                  {m.sourcePath}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HooksTable({ rows }: { rows: InstalledHook[] }) {
  return (
    <table className="tv-skills__table">
      <thead>
        <tr>
          <th>Event</th>
          <th>Matcher</th>
          <th>Type</th>
          <th>Handler</th>
          <th>Timeout</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h, i) => {
          const handler = h.command ?? h.url;
          return (
            <tr key={`${h.sourcePath}:${h.event}:${h.matcher ?? ''}:${i}`} className="tv-skills__row">
              <td>
                <span className="tv-skills__name">{h.event}</span>
              </td>
              <td>
                {h.matcher ? (
                  <span className="tv-mono">{h.matcher}</span>
                ) : (
                  <span className="tv-muted">—</span>
                )}
              </td>
              <td>{h.type}</td>
              <td>{handler ? <Clip text={handler} /> : <span className="tv-muted">—</span>}</td>
              <td>{h.timeoutSec != null ? `${h.timeoutSec} s` : <span className="tv-muted">—</span>}</td>
              <td className="tv-skills__loc">
                {h.enabled === false ? DISABLED_CHIP : null}
                <ScopeChip scope={h.scope} plugin={h.plugin} />
                <span className="tv-mono tv-muted" title={h.sourcePath}>
                  {h.sourcePath}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function contentsText(p: InstalledPlugin): string | null {
  if (p.kind !== 'bundle' || !p.contents) return null;
  const parts = [
    p.contents.skills > 0 ? `${p.contents.skills} skill${p.contents.skills === 1 ? '' : 's'}` : null,
    p.contents.mcpServers > 0
      ? `${p.contents.mcpServers} MCP server${p.contents.mcpServers === 1 ? '' : 's'}`
      : null,
    p.contents.hooks > 0 ? `${p.contents.hooks} hook${p.contents.hooks === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function PluginsTable({ rows }: { rows: InstalledPlugin[] }) {
  return (
    <table className="tv-skills__table">
      <thead>
        <tr>
          <th>Plugin</th>
          <th>Kind</th>
          <th>Contents</th>
          <th>Status</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p, i) => {
          const contents = contentsText(p);
          return (
            <tr key={`${p.sourcePath}:${p.name}:${i}`} className="tv-skills__row">
              <td className="tv-skills__skill">
                <span className="tv-skills__name">
                  {p.name}
                  {p.marketplace ? <span className="tv-muted">@{p.marketplace}</span> : null}
                  {p.version ? <span className="tv-muted"> v{p.version}</span> : null}
                </span>
                {p.description ? <span className="tv-skills__desc tv-muted">{p.description}</span> : null}
              </td>
              <td>{p.kind}</td>
              <td>{contents ?? <span className="tv-muted">—</span>}</td>
              <td>{p.enabled === false ? DISABLED_CHIP : <span className="tv-muted">—</span>}</td>
              <td className="tv-skills__loc">
                <span className="tv-mono tv-muted" title={p.sourcePath}>
                  {p.sourcePath}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
