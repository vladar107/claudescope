/**
 * Cross-agent comparison table (Analytics → Agents): one row per agent over
 * the sessions in scope. Metrics an agent's source format cannot honestly
 * report arrive as `null` from the API and render as an "n/a" marker with the
 * reason in the tooltip — never as 0 (Antigravity stores no tokens; Copilot
 * only session-level usage; Junie's delegation is invisible). Client-side
 * sorting is enough here — the row count is the number of agents.
 *
 * Reuses the session-efficiency table classes: same visual table, different
 * data shape.
 */
import type { AgentComparisonRow } from '@claudescope/shared';
import { AgentBadge } from '../../components/index.js';
import { formatCount, formatCost, formatPct, formatPerCost } from './format.js';

/** Keys of the nullable numeric metrics a column can render. */
type MetricKey = {
  [K in keyof AgentComparisonRow]-?: AgentComparisonRow[K] extends number | null ? K : never;
}[keyof AgentComparisonRow];

interface Col {
  key: MetricKey;
  label: string;
  /** Header tooltip explaining the metric. */
  title?: string;
  /** n/a tooltip for this column — beats the row's general availability note. */
  naTitle?: string;
  /** Only rendered when "Show cache" is on. */
  cacheOnly?: boolean;
  fmt: (n: number) => string;
}

const intFmt = (n: number) => Math.round(n).toLocaleString();

const COLS: Col[] = [
  { key: 'sessions', label: 'Sessions', fmt: intFmt },
  { key: 'responses', label: 'Resp', title: 'Deduped assistant responses', fmt: intFmt },
  { key: 'toolCallsPerResponse', label: 'Tools/resp', fmt: (n) => n.toFixed(2) },
  { key: 'totalTokens', label: 'Tokens', fmt: formatCount },
  { key: 'costUsd', label: 'Cost', fmt: formatCost },
  { key: 'costPerSession', label: '$/session', fmt: formatPerCost },
  { key: 'costPerResponse', label: '$/resp', fmt: formatPerCost },
  { key: 'tokensPerResponse', label: 'Tok/resp', fmt: formatCount },
  { key: 'cacheHitRatio', label: 'Cache', title: 'Share of prompt tokens served from cache', cacheOnly: true, fmt: formatPct },
  { key: 'subagentShare', label: 'Subagents', title: 'Share of sessions that spawned subagents', fmt: formatPct },
  {
    key: 'errorRate',
    label: 'Err rate',
    title: 'Failed tool calls / tool calls (Copilot counts permission denials as errors)',
    naTitle: "This agent's source format carries no tool-error signal",
    fmt: formatPct,
  },
  {
    key: 'interrupts',
    label: 'Interrupts',
    title: 'User interrupts ([Request interrupted by user…] markers)',
    naTitle: 'Interrupts are recorded by Claude Code only',
    fmt: intFmt,
  },
];

/** A metric cell: the formatted number, or an explained n/a for a data gap. */
function MetricCell({ col, row }: { col: Col; row: AgentComparisonRow }) {
  const value = row[col.key];
  if (value === null) {
    return (
      <td className="tv-eff__num">
        <span className="tv-na" title={col.naTitle ?? row.availabilityNote ?? 'Not recorded by this agent'}>
          n/a
        </span>
      </td>
    );
  }
  return <td className="tv-eff__num">{col.fmt(value)}</td>;
}

export function AgentComparisonTable({
  rows,
  showCache,
}: {
  rows: AgentComparisonRow[];
  showCache: boolean;
}) {
  const cols = COLS.filter((c) => showCache || !c.cacheOnly);
  return (
    <section className="tv-card tv-eff">
      <div className="tv-eff__head">
        <h2 className="tv-eff__title">Agent comparison</h2>
        <span className="tv-eff__hint">
          sessions in scope · n/a = not recorded by that agent (hover for why)
        </span>
      </div>
      <div className="tv-eff__scroll">
        <table className="tv-eff__table">
          <thead>
            <tr>
              <th>Agent</th>
              {cols.map((c) => (
                <th key={c.key} className="tv-eff__num" title={c.title}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.connectorId}>
                <td>
                  <AgentBadge connectorId={row.connectorId} />
                </td>
                {cols.map((c) => (
                  <MetricCell key={c.key} col={c} row={row} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
