/**
 * Session-efficiency table: per-session ratios with a median footer row. Sorting
 * is server-driven (Top-N is computed server-side), so a header click calls
 * onSortChange and the page re-queries. Rows deep-link to the session.
 */
import { Link } from 'react-router-dom';
import type { SessionEfficiencyResponse, SessionEfficiencySort } from '@claudescope/shared';
import { agentLabel } from '../../components/index.js';
import { formatCount, formatCost, formatPct, formatDuration, formatPerCost } from './format.js';

interface Column {
  key: SessionEfficiencySort;
  label: string;
  render: (r: SessionEfficiencyResponse['rows'][number]) => string;
  median?: (m: SessionEfficiencyResponse['summary']['median']) => string;
}

const COLUMNS: Column[] = [
  { key: 'responses', label: 'Resp', render: (r) => String(r.responses) },
  { key: 'cost', label: 'Cost', render: (r) => formatCost(r.costUsd) },
  { key: 'tokens', label: 'Tokens', render: (r) => formatCount(r.totalTokens) },
  { key: 'duration', label: 'Dur', render: (r) => formatDuration(r.durationMs) },
  { key: 'cacheHitRatio', label: 'Cache', render: (r) => formatPct(r.cacheHitRatio), median: (m) => formatPct(m.cacheHitRatio) },
  { key: 'costPerResponse', label: '$/resp', render: (r) => formatPerCost(r.costPerResponse), median: (m) => formatPerCost(m.costPerResponse) },
  { key: 'tokensPerResponse', label: 'Tok/resp', render: (r) => formatCount(r.tokensPerResponse), median: (m) => formatCount(m.tokensPerResponse) },
  { key: 'toolCallsPerResponse', label: 'Tools/resp', render: (r) => r.toolCallsPerResponse.toFixed(2), median: (m) => m.toolCallsPerResponse.toFixed(2) },
];

export function SessionEfficiencyTable({
  data,
  sort,
  onSortChange,
}: {
  data: SessionEfficiencyResponse;
  sort: SessionEfficiencySort;
  onSortChange: (s: SessionEfficiencySort) => void;
}) {
  return (
    <table className="tv-eff-table">
      <thead>
        <tr>
          <th className="tv-eff-table__session">Session</th>
          {COLUMNS.map((c) => (
            <th key={c.key}>
              <button
                type="button"
                className={sort === c.key ? 'tv-eff-table__sort is-active' : 'tv-eff-table__sort'}
                aria-pressed={sort === c.key}
                onClick={() => onSortChange(c.key)}
              >
                {c.label}
                {sort === c.key && <span aria-hidden="true"> ↓</span>}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((r) => (
          <tr key={r.sessionId}>
            <td className="tv-eff-table__session">
              <Link to={`/sessions/${r.sessionId}`} className="tv-eff-table__link">
                <span className="tv-eff-table__title">{r.title || '(untitled)'}</span>
                <span className="tv-eff-table__meta">
                  {r.projectDisplayName} · {agentLabel(r.connectorId)}
                </span>
              </Link>
            </td>
            {COLUMNS.map((c) => (
              <td key={c.key}>{c.render(r)}</td>
            ))}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="tv-eff-table__median">
          <td className="tv-eff-table__session">median · {data.summary.sessionCount} sessions</td>
          {COLUMNS.map((c) => (
            <td key={c.key}>{c.median ? c.median(data.summary.median) : '—'}</td>
          ))}
        </tr>
      </tfoot>
    </table>
  );
}
