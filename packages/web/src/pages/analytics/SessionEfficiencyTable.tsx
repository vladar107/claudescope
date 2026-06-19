/**
 * Session-efficiency table: per-session cost and efficiency ratios, ranked, with
 * a pinned median reference row and uniform IQR outlier flags.
 *
 * Sorting is server-driven (Top-N is computed server-side): a header click reports
 * the column via onSortChange, and the page toggles asc/desc and re-queries. Every
 * column is sortable. Outlier flags are derived from the per-column quartiles in
 * `summary` (computed over the full filtered set), so the same value is flagged
 * consistently regardless of page. Rows deep-link to the session. The Cache column
 * appears only when "Show cache" is on.
 */
import { Link } from 'react-router-dom';
import type {
  SessionEfficiencyResponse,
  SessionEfficiencyRow,
  SessionEfficiencySort,
  SessionEfficiencyStat,
  SortDir,
} from '@claudescope/shared';
import { AgentBadge } from '../../components/index.js';
import { formatCost, formatPct, formatPerCost } from './format.js';

/** Numeric columns share a key across the row and the summary's per-column stats. */
type ColKey = keyof SessionEfficiencyResponse['summary']['columns'];

interface Col {
  key: ColKey;
  label: string;
  sortKey: SessionEfficiencySort;
  /** Apply IQR outlier flagging (the ratio columns only). */
  flag?: boolean;
  /** Only rendered when "Show cache" is on. */
  cacheOnly?: boolean;
  fmt: (n: number) => string;
}

const intFmt = (n: number) => Math.round(n).toLocaleString();

const COLS: Col[] = [
  { key: 'responses', label: 'Resp', sortKey: 'responses', fmt: intFmt },
  { key: 'costUsd', label: 'Cost', sortKey: 'cost', fmt: formatCost },
  { key: 'costPerResponse', label: '$/resp', sortKey: 'costPerResponse', flag: true, fmt: formatPerCost },
  { key: 'toolCallCount', label: 'Tools', sortKey: 'toolCallCount', fmt: intFmt },
  { key: 'toolCallsPerResponse', label: 'Tools/resp', sortKey: 'toolCallsPerResponse', flag: true, fmt: (n) => n.toFixed(2) },
  { key: 'cacheHitRatio', label: 'Cache', sortKey: 'cacheHitRatio', flag: true, cacheOnly: true, fmt: formatPct },
];

/** IQR / Tukey fence: 'hi' above q3 + 1.5·IQR, 'lo' below q1 − 1.5·IQR, else none. */
function outlierDir(value: number, stat: SessionEfficiencyStat): 'hi' | 'lo' | null {
  const iqr = stat.q3 - stat.q1;
  if (!(iqr > 0)) return null;
  if (value > stat.q3 + 1.5 * iqr) return 'hi';
  if (value < stat.q1 - 1.5 * iqr) return 'lo';
  return null;
}

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SessionEfficiencySort;
  active: boolean;
  dir: SortDir;
  onSort: (s: SessionEfficiencySort) => void;
  className: string;
}) {
  return (
    <th className={className} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={active ? 'tv-eff__sort is-active' : 'tv-eff__sort'}
        aria-pressed={active}
        onClick={() => onSort(sortKey)}
      >
        {label}
        {active ? (
          <span className="tv-eff__car" aria-hidden="true">
            {dir === 'asc' ? '↑' : '↓'}
          </span>
        ) : null}
      </button>
    </th>
  );
}

function NumCell({
  col,
  row,
  stat,
}: {
  col: Col;
  row: SessionEfficiencyRow;
  stat: SessionEfficiencyStat;
}) {
  const value = row[col.key];
  const text = col.fmt(value);
  const dir = col.flag ? outlierDir(value, stat) : null;
  if (!dir) return <td className="tv-eff__num">{text}</td>;
  return (
    <td className="tv-eff__num">
      <span
        className="tv-eff__out"
        title={dir === 'hi' ? 'Unusually high (IQR outlier)' : 'Unusually low (IQR outlier)'}
      >
        {text}
        <span className="tv-eff__mk" aria-hidden="true">
          {dir === 'hi' ? '▲' : '▼'}
        </span>
      </span>
    </td>
  );
}

export function SessionEfficiencyTable({
  data,
  sort,
  dir,
  onSortChange,
  showCache,
}: {
  data: SessionEfficiencyResponse;
  sort: SessionEfficiencySort;
  dir: SortDir;
  onSortChange: (s: SessionEfficiencySort) => void;
  showCache: boolean;
}) {
  const { summary } = data;
  const cols = COLS.filter((c) => !c.cacheOnly || showCache);
  const concentration = summary.totalCostUsd > 0 ? summary.top3CostUsd / summary.totalCostUsd : 0;

  return (
    <>
      <div className="tv-eff__summary">
        <span>
          <strong>{summary.sessionCount}</strong> session{summary.sessionCount === 1 ? '' : 's'}
        </span>
        <span className="tv-eff__dot">·</span>
        <span>
          <strong>{formatCost(summary.totalCostUsd)}</strong> est. spend in range
        </span>
        {summary.sessionCount > 3 && concentration > 0 ? (
          <span className="tv-eff__insight">
            Top 3 sessions ≈ <strong>{formatPct(concentration)}</strong> of spend
          </span>
        ) : null}
      </div>

      <section className="tv-eff">
        <div className="tv-eff__head">
          <h2 className="tv-eff__title">Session efficiency</h2>
          <span className="tv-eff__hint">
            top {data.rows.length} · click a column to sort · median pinned for reference
          </span>
        </div>
        <div className="tv-eff__legend">
          <span>Outliers (IQR, recomputed for the current filter):</span>
          <span className="tv-eff__leg">
            <span className="tv-eff__out">
              value <span className="tv-eff__mk">▲</span>
            </span>{' '}
            unusually high
          </span>
          <span className="tv-eff__leg">
            <span className="tv-eff__out">
              value <span className="tv-eff__mk">▼</span>
            </span>{' '}
            unusually low
          </span>
        </div>

        <div className="tv-eff__scroll">
          <table className="tv-eff__table">
            <thead>
              <tr>
                <SortHeader
                  label="Session"
                  sortKey="title"
                  className="tv-eff__sess"
                  active={sort === 'title'}
                  dir={dir}
                  onSort={onSortChange}
                />
                {cols.map((c) => (
                  <SortHeader
                    key={c.key}
                    label={c.label}
                    sortKey={c.sortKey}
                    className="tv-eff__num"
                    active={sort === c.sortKey}
                    dir={dir}
                    onSort={onSortChange}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="tv-eff__median">
                <td className="tv-eff__sess">
                  <span className="tv-eff__medlbl">Median · {summary.sessionCount} sessions</span>
                </td>
                {cols.map((c) => (
                  <td key={c.key} className="tv-eff__num">
                    {c.fmt(summary.columns[c.key].median)}
                  </td>
                ))}
              </tr>
              {data.rows.map((r) => (
                <tr key={r.sessionId} className="tv-eff__row">
                  <td className="tv-eff__sess">
                    <Link to={`/sessions/${r.sessionId}`} className="tv-eff__link">
                      <span className="tv-eff__name">{r.title || '(untitled)'}</span>
                      <span className="tv-eff__sub">
                        <AgentBadge connectorId={r.connectorId} />
                        <span className="tv-eff__proj">{r.projectDisplayName}</span>
                      </span>
                    </Link>
                  </td>
                  {cols.map((c) => (
                    <NumCell key={c.key} col={c} row={r} stat={summary.columns[c.key]} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
