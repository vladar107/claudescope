/** Shared chart constants + a themed tooltip for the analytics charts. */

import type { ReactNode } from 'react';
import type { ResolvedTheme } from '../../theme/ThemeProvider.js';
import { formatCost, formatCount } from './format.js';

export interface ChartColors {
  input: string;
  output: string;
  cacheWrite: string;
  cacheRead: string;
  cost: string;
  grid: string;
  axis: string;
  /** Hover cursor fill — a faint overlay tuned to the surface luminance. */
  cursor: string;
}

/**
 * Chart palette per resolved theme. Series hues mirror the global role-accent
 * tokens for each theme (--tv-user/assistant/success/warning); grid/axis/cursor
 * track the surface so charts read correctly on both backgrounds.
 */
const DARK_COLORS: ChartColors = {
  input: '#58a6ff', // --tv-accent / user
  output: '#bc8cff', // assistant
  cacheWrite: '#3fb950', // success
  cacheRead: '#2ea043',
  cost: '#d29922', // warning / tool
  grid: '#2a3038', // --tv-border
  axis: '#9aa6b2', // --tv-fg-muted
  cursor: '#ffffff0a',
};
const LIGHT_COLORS: ChartColors = {
  input: '#0969da',
  output: '#8250df',
  cacheWrite: '#1a7f37',
  cacheRead: '#2da44e',
  cost: '#9a6700',
  grid: '#d0d7de',
  axis: '#656d76',
  cursor: '#0000000a',
};

/** Resolve the chart palette for the active theme. */
export function getChartColors(theme: ResolvedTheme): ChartColors {
  return theme === 'light' ? LIGHT_COLORS : DARK_COLORS;
}

/** Axis tick styling for a given palette. */
export function axisTick(colors: ChartColors): { fill: string; fontSize: number } {
  return { fill: colors.axis, fontSize: 11 };
}

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
