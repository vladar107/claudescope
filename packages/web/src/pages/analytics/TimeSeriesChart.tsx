/**
 * Per-day time series: stacked token bars (input/output/cache) with cost drawn
 * as a line on a secondary axis. Expects rows grouped by day (`key` = YYYY-MM-DD),
 * which it sorts chronologically before charting.
 */

import { useMemo, useState } from 'react';
import type { AnalyticsRow } from '@claudescope/shared';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useTheme } from '../../theme/ThemeProvider.js';
import {
  axisTick,
  getChartColors,
  TooltipCard,
  formatCost,
  formatCount,
  type ChartColors,
} from './chart-common.js';

interface Point {
  day: string;
  input: number;
  output: number;
  cache: number;
  cost: number;
  total: number;
}

export function TimeSeriesChart({ rows, showCache }: { rows: AnalyticsRow[]; showCache: boolean }) {
  const data = useMemo<Point[]>(
    () =>
      rows
        .map((r) => ({
          day: r.key,
          input: r.inputTokens,
          output: r.outputTokens,
          cache: r.cacheCreationTokens + r.cacheReadTokens,
          cost: r.costUsd,
          total: r.totalTokens,
        }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    [rows],
  );

  // Click a legend item to hide/show that series. Cache reads dwarf input/output,
  // so hiding "Cache" lets the axis rescale and reveals the smaller bars.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const { resolvedTheme } = useTheme();
  const colors = getChartColors(resolvedTheme);
  const tick = axisTick(colors);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={colors.grid} vertical={false} />
        <XAxis dataKey="day" tick={tick} tickLine={false} axisLine={{ stroke: colors.grid }} minTickGap={24} />
        <YAxis
          yAxisId="tokens"
          tick={tick}
          tickLine={false}
          axisLine={{ stroke: colors.grid }}
          tickFormatter={(v: number) => formatCount(v)}
          width={48}
        />
        <YAxis
          yAxisId="cost"
          orientation="right"
          tick={tick}
          tickLine={false}
          axisLine={{ stroke: colors.grid }}
          tickFormatter={(v: number) => `$${v < 1 ? v.toFixed(2) : Math.round(v)}`}
          width={52}
        />
        <Tooltip cursor={{ fill: colors.cursor }} content={<SeriesTooltip colors={colors} />} />
        <Legend
          wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
          onClick={(e) => {
            const key = (e as { dataKey?: unknown }).dataKey;
            if (typeof key === 'string') toggle(key);
          }}
          formatter={(value, entry) => {
            const key = (entry as { dataKey?: unknown } | undefined)?.dataKey;
            const off = typeof key === 'string' && hidden.has(key);
            return (
              <span style={off ? { color: 'var(--tv-fg-muted)', textDecoration: 'line-through' } : undefined}>
                {value}
              </span>
            );
          }}
        />
        <Bar yAxisId="tokens" dataKey="input" name="Input" stackId="tok" fill={colors.input} hide={hidden.has('input')} isAnimationActive={false} />
        <Bar yAxisId="tokens" dataKey="output" name="Output" stackId="tok" fill={colors.output} hide={hidden.has('output')} isAnimationActive={false} />
        {showCache && (
          <Bar yAxisId="tokens" dataKey="cache" name="Cache" stackId="tok" fill={colors.cacheWrite} radius={[2, 2, 0, 0]} hide={hidden.has('cache')} isAnimationActive={false} />
        )}
        <Line yAxisId="cost" type="monotone" dataKey="cost" name="Cost" stroke={colors.cost} strokeWidth={2} dot={false} hide={hidden.has('cost')} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Recharts hands the tooltip a loosely-typed payload; narrow it here. */
function SeriesTooltip(props: {
  active?: boolean;
  label?: string | number;
  payload?: ReadonlyArray<{ payload?: Point }>;
  colors: ChartColors;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) return null;
  const p = props.payload[0]?.payload;
  if (!p) return null;
  const { colors } = props;
  return (
    <TooltipCard
      title={p.day}
      rows={[
        { label: 'Input', value: formatCount(p.input), color: colors.input },
        { label: 'Output', value: formatCount(p.output), color: colors.output },
        { label: 'Cache', value: formatCount(p.cache), color: colors.cacheWrite },
        { label: 'Total tokens', value: formatCount(p.total) },
        { label: 'Cost', value: formatCost(p.cost), color: colors.cost },
      ]}
    />
  );
}
