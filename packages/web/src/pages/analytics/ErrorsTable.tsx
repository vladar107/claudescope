/**
 * Error/interrupt signals table (Analytics → Errors): one row per agent.
 * Metrics an agent's source format cannot report arrive as `null` from the API
 * and render as "n/a" with the reason in the tooltip — never 0 (Junie and
 * Antigravity have no tool-error signal; interrupts are recorded by Claude
 * Code only). Reuses the session-efficiency table classes.
 */
import type { ErrorAnalyticsRow } from '@claudescope/shared';
import { AgentBadge } from '../../components/index.js';
import { formatPct } from './format.js';

const intFmt = (n: number) => Math.round(n).toLocaleString();

interface Col {
  label: string;
  title?: string;
  value: (r: ErrorAnalyticsRow) => number | null;
  fmt: (n: number) => string;
}

const COLS: Col[] = [
  { label: 'Sessions', value: (r) => r.sessions, fmt: intFmt },
  { label: 'Tool calls', value: (r) => r.toolCalls, fmt: intFmt },
  { label: 'Errors', title: 'Failed tool calls (is_error results)', value: (r) => r.toolErrors, fmt: intFmt },
  { label: 'Error rate', value: (r) => r.errorRate, fmt: formatPct },
  { label: 'Interrupts', title: 'User interrupts (Claude Code records these)', value: (r) => r.interrupts, fmt: intFmt },
  { label: 'Interrupts/session', value: (r) => r.interruptsPerSession, fmt: (n) => n.toFixed(2) },
];

export function ErrorsTable({ rows }: { rows: ErrorAnalyticsRow[] }) {
  return (
    <section className="tv-card tv-eff">
      <div className="tv-eff__head">
        <h2 className="tv-eff__title">Errors & interrupts</h2>
        <span className="tv-eff__hint">
          n/a = the agent's format doesn't record it (hover for why) · interrupts are Claude Code only
        </span>
      </div>
      <div className="tv-eff__scroll">
        <table className="tv-eff__table">
          <thead>
            <tr>
              <th>Agent</th>
              {COLS.map((c) => (
                <th key={c.label} className="tv-eff__num" title={c.title}>
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
                {COLS.map((c) => {
                  const v = c.value(row);
                  return (
                    <td key={c.label} className="tv-eff__num">
                      {v === null ? (
                        <span className="tv-na" title={row.availabilityNote ?? 'Not recorded by this agent'}>
                          n/a
                        </span>
                      ) : (
                        c.fmt(v)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
