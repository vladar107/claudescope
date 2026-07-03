/**
 * Analytics dashboard (/analytics).
 *
 * Calls `GET /api/analytics` with a group-by toggle (project | model | day) and
 * an optional date range, then renders:
 *   - summary cards (total tokens, total cost, assistant messages, input-from-cache)
 *   - a per-day time series of tokens + cost (always fetched on `day`)
 *   - a breakdown bar chart for the active group-by (token + cost)
 *
 * Notes: analytics rows/totals are over ASSISTANT events only (the events that
 * carry usage), per the API contract. `messageCount` here is the assistant
 * message count. The "input from cache" share is
 * `cacheRead / (cacheRead + cacheCreation + input)`.
 */

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ActivityResponse,
  AgentComparisonResponse,
  DigestResponse,
  AnalyticsGroupBy,
  AnalyticsResponse,
  AnalyticsTotals,
  ProjectMeta,
  SessionEfficiencyResponse,
  SessionEfficiencySort,
  SortDir,
  StreakInfo,
  ToolUsageResponse,
} from '@claudescope/shared';
import { api } from '../../api/client.js';
import { ErrorBox, Spinner } from '../../components/index.js';
import { AgentComparisonTable } from './AgentComparisonTable.js';
import { DigestView } from './DigestView.js';
import { BreakdownChart } from './BreakdownChart.js';
import { ToolUsageChart } from './ToolUsageChart.js';
import type { BreakdownMetric, BreakdownSort } from './BreakdownChart.js';
import { TimeSeriesChart } from './TimeSeriesChart.js';
import { formatCount, formatCost, formatPct } from './format.js';
import { SessionEfficiencyTable } from './SessionEfficiencyTable.js';
import './analytics.css';

const GROUP_OPTIONS: { value: AnalyticsGroupBy; label: string }[] = [
  { value: 'project', label: 'By project' },
  { value: 'agent', label: 'By agent' },
  { value: 'model', label: 'By model' },
  { value: 'day', label: 'By day' },
];

const METRIC_OPTIONS: { value: BreakdownMetric; label: string }[] = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
];
const SORT_OPTIONS: { value: BreakdownSort; label: string }[] = [
  { value: 'tokens', label: 'Tokens' },
  { value: 'cost', label: 'Cost' },
];

/** Fetch state for one analytics query. */
interface QueryState {
  data: AnalyticsResponse | null;
  loading: boolean;
  error: unknown;
}

const INITIAL: QueryState = { data: null, loading: true, error: null };

export function AnalyticsPage() {
  const [groupBy, setGroupBy] = useState<AnalyticsGroupBy>('project');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Cache tokens dwarf input/output and clutter the charts — hidden by default.
  const [showCache, setShowCache] = useState(false);
  const [view, setView] = useState<'overview' | 'efficiency' | 'digest'>('overview');
  // Efficiency grain: the same analysis at two grouping levels — per-agent
  // scorecard (comparison) or per-session table (outlier hunting).
  const [grain, setGrain] = useState<'agents' | 'sessions'>('agents');
  const [effSort, setEffSort] = useState<SessionEfficiencySort>('cost');
  const [effDir, setEffDir] = useState<SortDir>('desc');
  const [eff, setEff] = useState<{
    data: SessionEfficiencyResponse | null;
    loading: boolean;
    error: unknown;
  }>({ data: null, loading: true, error: null });
  const [effRetry, setEffRetry] = useState(0);
  // Efficiency view: optional project scope ('' = whole corpus), shared by both grains.
  const [effProject, setEffProject] = useState('');
  const [agents, setAgents] = useState<{
    data: AgentComparisonResponse | null;
    loading: boolean;
    error: unknown;
  }>({ data: null, loading: true, error: null });
  const [agentsRetry, setAgentsRetry] = useState(0);
  // Digest view fetch state (range comes from the shared from/to inputs).
  const [digest, setDigest] = useState<{
    data: DigestResponse | null;
    loading: boolean;
    error: unknown;
  }>({ data: null, loading: true, error: null });
  const [digestRetry, setDigestRetry] = useState(0);
  // Breakdown chart controls (default to tokens, preserving prior behavior):
  // `metric` picks what the bars render, `sortBy` picks the row order.
  const [metric, setMetric] = useState<BreakdownMetric>('tokens');
  const [sortBy, setSortBy] = useState<BreakdownSort>('tokens');

  // Project id -> metadata, so the breakdown can label project bars with the
  // same human-friendly name (and cwd) the Browse tab shows, instead of the
  // raw stable id. Fetched once; date range / group-by don't affect it.
  const [projectsById, setProjectsById] = useState<Map<string, ProjectMeta>>(new Map());

  // The breakdown query follows the active group-by toggle.
  const [breakdown, setBreakdown] = useState<QueryState>(INITIAL);
  // The time series is always grouped by day (independent of the toggle) so the
  // trend chart is available regardless of the selected breakdown dimension.
  const [series, setSeries] = useState<QueryState>(INITIAL);
  const [activity, setActivity] = useState<{ data: ActivityResponse | null; loading: boolean; error: unknown }>({ data: null, loading: true, error: null });
  const [tools, setTools] = useState<{ data: ToolUsageResponse | null; loading: boolean; error: unknown }>({ data: null, loading: true, error: null });

  // Convert the date inputs (YYYY-MM-DD, local) into inclusive ISO bounds.
  const range = useMemo(() => {
    const fromIso = from ? new Date(`${from}T00:00:00`).toISOString() : undefined;
    const toIso = to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined;
    return { from: fromIso, to: toIso };
  }, [from, to]);

  const load = useCallback(() => {
    const ctrl = new AbortController();
    setBreakdown((s) => ({ ...s, loading: true, error: null }));
    setSeries((s) => ({ ...s, loading: true, error: null }));

    api
      .analytics({ groupBy, from: range.from, to: range.to }, ctrl.signal)
      .then((data) => setBreakdown({ data, loading: false, error: null }))
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        setBreakdown({ data: null, loading: false, error });
      });

    api
      .analytics({ groupBy: 'day', from: range.from, to: range.to }, ctrl.signal)
      .then((data) => setSeries({ data, loading: false, error: null }))
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        setSeries({ data: null, loading: false, error });
      });

    return () => ctrl.abort();
  }, [groupBy, range.from, range.to]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (view !== 'efficiency' || grain !== 'sessions') return;
    const ctrl = new AbortController();
    setEff((s) => ({ ...s, loading: true, error: null }));
    api
      .sessionEfficiency(
        { project: effProject || undefined, from: range.from, to: range.to, sort: effSort, dir: effDir, limit: 50 },
        ctrl.signal,
      )
      .then((data) => setEff({ data, loading: false, error: null }))
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        setEff({ data: null, loading: false, error });
      });
    return () => ctrl.abort();
  }, [view, grain, effProject, range.from, range.to, effSort, effDir, effRetry]);

  useEffect(() => {
    if (view !== 'efficiency' || grain !== 'agents') return;
    const ctrl = new AbortController();
    setAgents((s) => ({ ...s, loading: true, error: null }));
    api
      .analyticsAgents({ project: effProject || undefined, from: range.from, to: range.to }, ctrl.signal)
      .then((data) => setAgents({ data, loading: false, error: null }))
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        setAgents({ data: null, loading: false, error });
      });
    return () => ctrl.abort();
  }, [view, grain, effProject, range.from, range.to, agentsRetry]);

  useEffect(() => {
    if (view !== 'digest') return;
    const ctrl = new AbortController();
    setDigest((s) => ({ ...s, loading: true, error: null }));
    api
      .analyticsDigest({ from: range.from, to: range.to }, ctrl.signal)
      .then((data) => setDigest({ data, loading: false, error: null }))
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        setDigest({ data: null, loading: false, error });
      });
    return () => ctrl.abort();
  }, [view, range.from, range.to, digestRetry]);

  useEffect(() => {
    if (view !== 'overview') return;
    const ctrl = new AbortController();
    const tzOffsetMinutes = -new Date().getTimezoneOffset(); // east-of-UTC positive
    const today = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();
    setActivity((s) => ({ ...s, loading: true }));
    api
      .analyticsActivity({ from: range.from, to: range.to, tzOffsetMinutes, today }, ctrl.signal)
      .then((data) => setActivity({ data, loading: false, error: null }))
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        setActivity({ data: null, loading: false, error });
      });
    return () => ctrl.abort();
  }, [view, range.from, range.to]);

  useEffect(() => {
    if (view !== 'efficiency' || grain !== 'agents') return;
    const ctrl = new AbortController();
    setTools((s) => ({ ...s, loading: true }));
    api
      .analyticsTools({ project: effProject || undefined, from: range.from, to: range.to }, ctrl.signal)
      .then((data) => setTools({ data, loading: false, error: null }))
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        setTools({ data: null, loading: false, error });
      });
    return () => ctrl.abort();
  }, [view, grain, effProject, range.from, range.to]);

  // Header click: re-clicking the active column flips direction; a new column
  // starts at descending (largest first).
  const onEffSort = (key: SessionEfficiencySort) => {
    if (key === effSort) setEffDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setEffSort(key);
      setEffDir('desc');
    }
  };

  // Load the project list once for id -> displayName mapping. On failure the
  // breakdown falls back to the raw key, so a missing list never blocks it.
  useEffect(() => {
    const ctrl = new AbortController();
    api
      .listProjects(ctrl.signal)
      .then((list) => setProjectsById(new Map(list.map((p) => [p.id, p]))))
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  // Totals are identical across both queries (same filter, different grouping);
  // prefer whichever has loaded.
  const totals = breakdown.data?.totals ?? series.data?.totals ?? null;
  const error = breakdown.error ?? series.error;
  const totalsLoading = (breakdown.loading || series.loading) && !totals;

  return (
    <div className="tv-analytics">
      <h1 className="tv-page-title">Analytics</h1>

      <div className="tv-analytics__toolbar">
        <div className="tv-analytics__field">
          <span className="tv-analytics__field-label">View</span>
          <div className="tv-segmented" role="group" aria-label="View">
            <button
              type="button"
              className={view === 'overview' ? 'tv-segmented__btn is-active' : 'tv-segmented__btn'}
              aria-pressed={view === 'overview'}
              onClick={() => setView('overview')}
            >
              Overview
            </button>
            <button
              type="button"
              className={view === 'efficiency' ? 'tv-segmented__btn is-active' : 'tv-segmented__btn'}
              aria-pressed={view === 'efficiency'}
              onClick={() => setView('efficiency')}
            >
              Efficiency
            </button>
            <button
              type="button"
              className={view === 'digest' ? 'tv-segmented__btn is-active' : 'tv-segmented__btn'}
              aria-pressed={view === 'digest'}
              onClick={() => setView('digest')}
            >
              Digest
            </button>
          </div>
        </div>

        {view === 'efficiency' && (
          <div className="tv-analytics__field">
            <span className="tv-analytics__field-label">Grain</span>
            <div className="tv-segmented" role="group" aria-label="Grain">
              <button
                type="button"
                className={grain === 'agents' ? 'tv-segmented__btn is-active' : 'tv-segmented__btn'}
                aria-pressed={grain === 'agents'}
                onClick={() => setGrain('agents')}
              >
                Agents
              </button>
              <button
                type="button"
                className={grain === 'sessions' ? 'tv-segmented__btn is-active' : 'tv-segmented__btn'}
                aria-pressed={grain === 'sessions'}
                onClick={() => setGrain('sessions')}
              >
                Sessions
              </button>
            </div>
          </div>
        )}

        {view === 'efficiency' && (
          <div className="tv-analytics__field">
            <label className="tv-analytics__field-label" htmlFor="tv-eff-project">
              Project
            </label>
            <select
              id="tv-eff-project"
              className="tv-analytics__select"
              value={effProject}
              onChange={(e) => setEffProject(e.target.value)}
            >
              <option value="">All projects</option>
              {[...projectsById.values()]
                .sort((a, b) => a.displayName.localeCompare(b.displayName))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
            </select>
          </div>
        )}

        {view === 'overview' && (
          <div className="tv-analytics__field">
            <label className="tv-analytics__field-label" htmlFor="tv-group-by">
              Group by
            </label>
            <select
              id="tv-group-by"
              className="tv-analytics__select"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as AnalyticsGroupBy)}
            >
              {GROUP_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="tv-analytics__dates">
          <div className="tv-analytics__field">
            <label className="tv-analytics__field-label" htmlFor="tv-from">
              From
            </label>
            <input
              id="tv-from"
              type="date"
              className="tv-analytics__date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>

          <div className="tv-analytics__field">
            <label className="tv-analytics__field-label" htmlFor="tv-to">
              To
            </label>
            <input
              id="tv-to"
              type="date"
              className="tv-analytics__date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>

          {(from || to) && (
            <button
              type="button"
              className="tv-analytics__clear"
              onClick={() => {
                setFrom('');
                setTo('');
              }}
            >
              Clear dates
            </button>
          )}
        </div>

        {view !== 'digest' && (
          <label className="tv-analytics__toggle">
            <input
              type="checkbox"
              className="tv-switch__input"
              checked={showCache}
              onChange={(e) => setShowCache(e.target.checked)}
            />
            <span className="tv-switch" aria-hidden="true" />
            Show cache
          </label>
        )}
      </div>

      {view === 'efficiency' && grain === 'sessions' ? (
        eff.error ? (
          <ErrorBox
            error={eff.error}
            title="Failed to load session efficiency"
            onRetry={() => setEffRetry((n) => n + 1)}
          />
        ) : eff.loading && !eff.data ? (
          <div className="tv-card">
            <Spinner label="Loading…" />
          </div>
        ) : !eff.data || eff.data.rows.length === 0 ? (
          <div className="tv-card tv-chart-empty">No sessions in range.</div>
        ) : (
          <SessionEfficiencyTable
            data={eff.data}
            sort={effSort}
            dir={effDir}
            onSortChange={onEffSort}
            showCache={showCache}
          />
        )
      ) : view === 'digest' ? (
        digest.error ? (
          <ErrorBox
            error={digest.error}
            title="Failed to load the digest"
            onRetry={() => setDigestRetry((n) => n + 1)}
          />
        ) : digest.loading && !digest.data ? (
          <div className="tv-card">
            <Spinner label="Loading…" />
          </div>
        ) : !digest.data ? (
          <div className="tv-card tv-chart-empty">No data.</div>
        ) : (
          <DigestView
            data={digest.data}
            onRange={(f, t) => {
              setFrom(f);
              setTo(t);
            }}
          />
        )
      ) : view === 'efficiency' ? (
        agents.error ? (
          <ErrorBox
            error={agents.error}
            title="Failed to load agent comparison"
            onRetry={() => setAgentsRetry((n) => n + 1)}
          />
        ) : agents.loading && !agents.data ? (
          <div className="tv-card">
            <Spinner label="Loading…" />
          </div>
        ) : !agents.data || agents.data.rows.length === 0 ? (
          <div className="tv-card tv-chart-empty">No sessions in range.</div>
        ) : (
          <>
            <div className="tv-analytics__cards">
              <StatCard
                label="PR-linked sessions"
                value={formatCount(agents.data.prLinked.sessions)}
                sub={
                  agents.data.prLinked.costPerPrSession !== null
                    ? `${formatCost(agents.data.prLinked.costUsd)} total · ${formatCost(agents.data.prLinked.costPerPrSession)} per PR session · PR links recorded by Claude Code only`
                    : 'PR links are recorded by Claude Code only'
                }
              />
            </div>
            <AgentComparisonTable rows={agents.data.rows} showCache={showCache} />
            <div className="tv-analytics__charts">
              <ChartCard
                title="Tool usage"
                hint="calls by category"
                loading={tools.loading}
                empty={!tools.data || tools.data.rows.length === 0}
              >
                {tools.data && <ToolUsageChart rows={tools.data.rows} />}
              </ChartCard>
            </div>
          </>
        )
      ) : error ? (
        <ErrorBox error={error} title="Failed to load analytics" onRetry={load} />
      ) : (
        <>
          <SummaryCards
            totals={totals}
            loading={totalsLoading}
            showCache={showCache}
            streak={activity.data?.streak ?? null}
          />

          <div className="tv-analytics__charts">
            <ChartCard
              title="Tokens & cost over time"
              hint="grouped by day"
              loading={series.loading}
              empty={!series.data || series.data.rows.length === 0}
            >
              {series.data && <TimeSeriesChart rows={series.data.rows} showCache={showCache} />}
            </ChartCard>

            <ChartCard
              title={`Breakdown ${groupByNoun(groupBy)}`}
              hint={`top 15 by ${sortBy === 'cost' ? 'cost' : 'tokens'}`}
              loading={breakdown.loading}
              empty={!breakdown.data || breakdown.data.rows.length === 0}
              actions={
                <>
                  <SegmentedControl
                    label="Metric"
                    options={METRIC_OPTIONS}
                    value={metric}
                    onChange={setMetric}
                  />
                  <SegmentedControl
                    label="Sort by"
                    options={SORT_OPTIONS}
                    value={sortBy}
                    onChange={setSortBy}
                  />
                </>
              }
            >
              {breakdown.data && (
                <BreakdownChart
                  rows={breakdown.data.rows}
                  groupBy={groupBy}
                  showCache={showCache}
                  metric={metric}
                  sortBy={sortBy}
                  projectsById={projectsById}
                />
              )}
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}

function groupByNoun(g: AnalyticsGroupBy): string {
  return g === 'project'
    ? 'by project'
    : g === 'agent'
      ? 'by agent'
      : g === 'model'
        ? 'by model'
        : 'by day';
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

function SummaryCards({
  totals,
  loading,
  showCache,
  streak,
}: {
  totals: AnalyticsTotals | null;
  loading: boolean;
  showCache: boolean;
  streak: StreakInfo | null;
}) {
  if (loading) {
    return (
      <div className="tv-card" style={{ marginBottom: 'var(--tv-space-5)' }}>
        <Spinner label="Loading totals…" />
      </div>
    );
  }
  if (!totals) return null;

  // Reconcile the headline: total = input + output + cache. Cache reads usually
  // dominate, which is why the big number looks unexplained without the split.
  // "Show cache" governs the headline too — by default the total reflects only
  // billed input + output, and toggling cache on folds it back into the number,
  // the reconcile bar, and the legend.
  const cacheTokens = totals.cacheReadTokens + totals.cacheCreationTokens;
  const totalTokens = showCache ? totals.totalTokens : totals.inputTokens + totals.outputTokens;
  const cacheReadShare = totals.totalTokens > 0 ? totals.cacheReadTokens / totals.totalTokens : 0;

  return (
    <div className="tv-analytics__cards">
      <StatCard
        label="Total tokens"
        value={formatCount(totalTokens)}
        sub={
          <span className="tv-stat-card__tokens">
            <TokenMiniBar
              input={totals.inputTokens}
              output={totals.outputTokens}
              cache={showCache ? cacheTokens : 0}
            />
            <span>
              {formatCount(totals.inputTokens)} in · {formatCount(totals.outputTokens)} out
              {showCache && <> · {formatCount(cacheTokens)} cache</>}
            </span>
          </span>
        }
      />
      <StatCard
        label="Total cost"
        value={formatCost(totals.costUsd)}
        sub={`list-price estimate · ${formatPct(cacheReadShare)} of tokens cache-read`}
      />
      <StatCard
        label="Assistant messages"
        value={formatCount(totals.messageCount)}
        sub="usage-bearing events"
      />
      {streak && (
        <StatCard
          label="Prompt streak"
          value={`🔥 ${streak.current} ${streak.current === 1 ? 'day' : 'days'}`}
          sub={`longest ${streak.longest}`}
        />
      )}
      {showCache && (
        <StatCard
          label="Input from cache"
          value={formatPct(totals.cacheHitRatio)}
          sub={`${formatCount(totals.cacheReadTokens)} read · ${formatCount(totals.cacheCreationTokens)} written`}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented control (reused by the breakdown chart's Metric / Sort toggles)
// ---------------------------------------------------------------------------

function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="tv-chart-card__control">
      <span className="tv-chart-card__control-label">{label}</span>
      <div className="tv-segmented tv-segmented--sm" role="group" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={value === opt.value ? 'tv-segmented__btn is-active' : 'tv-segmented__btn'}
            aria-pressed={value === opt.value}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="tv-card tv-stat-card">
      <span className="tv-stat-card__label">{label}</span>
      <span className="tv-stat-card__value">{value}</span>
      {sub != null && <span className="tv-stat-card__sub">{sub}</span>}
    </div>
  );
}

/**
 * A thin stacked bar showing how the total token count splits into input /
 * output / cache, so the headline number visibly reconciles. Spans (not divs)
 * so it nests inside the card's sub `<span>`; cache is muted since it dominates.
 */
function TokenMiniBar({ input, output, cache }: { input: number; output: number; cache: number }) {
  const total = input + output + cache || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <span className="tv-tokenbar" aria-hidden="true">
      <span className="tv-tokenbar__seg tv-tokenbar__in" style={{ width: pct(input) }} />
      <span className="tv-tokenbar__seg tv-tokenbar__out" style={{ width: pct(output) }} />
      <span className="tv-tokenbar__seg tv-tokenbar__cache" style={{ width: pct(cache) }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Chart card shell
// ---------------------------------------------------------------------------

function ChartCard({
  title,
  hint,
  loading,
  empty,
  actions,
  children,
}: {
  title: string;
  hint?: string;
  loading: boolean;
  empty: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="tv-card tv-chart-card">
      <div className="tv-chart-card__head">
        <div className="tv-chart-card__heading">
          <h2 className="tv-chart-card__title">{title}</h2>
          {hint && <span className="tv-chart-card__hint">{hint}</span>}
        </div>
        {actions && <div className="tv-chart-card__actions">{actions}</div>}
      </div>
      {loading ? (
        <div className="tv-chart-empty">
          <Spinner label="Loading…" />
        </div>
      ) : empty ? (
        <div className="tv-chart-empty">No data for the selected range.</div>
      ) : (
        children
      )}
    </section>
  );
}
