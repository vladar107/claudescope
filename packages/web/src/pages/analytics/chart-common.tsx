/** Shared chart constants + a themed tooltip for the analytics charts. */

import type { ReactNode } from 'react';
import { formatCost, formatCount } from './format.js';

/** Palette pulled from the global theme tokens (kept in sync manually). */
export const COLORS = {
  input: '#58a6ff', // --tv-accent / user
  output: '#bc8cff', // assistant
  cacheWrite: '#3fb950', // success
  cacheRead: '#2ea043',
  cost: '#d29922', // warning / tool
  grid: '#2a3038', // --tv-border
  axis: '#9aa6b2', // --tv-fg-muted
} as const;

/** Axis tick styling reused across charts. */
export const AXIS_TICK = { fill: COLORS.axis, fontSize: 11 } as const;

export interface TooltipDatum {
  label: string;
  value: ReactNode;
  color?: string;
}

/**
 * A presentational tooltip body. Chart files build the `title`/`rows` from the
 * recharts payload and hand them here, keeping recharts' loosely-typed payload
 * shape isolated to one spot per chart.
 */
export function TooltipCard({ title, rows }: { title: string; rows: TooltipDatum[] }) {
  return (
    <div className="tv-chart-tooltip">
      <div className="tv-chart-tooltip__label">{title}</div>
      {rows.map((r, i) => (
        <div className="tv-chart-tooltip__row" key={i}>
          <span className="tv-chart-tooltip__row-label">
            {r.color && (
              <span className="tv-chart-tooltip__swatch" style={{ background: r.color }} />
            )}
            {r.label}
          </span>
          <span className="tv-chart-tooltip__row-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export { formatCost, formatCount };
