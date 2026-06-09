/**
 * Horizontal breakdown bars for the active group-by (project | model | day):
 * stacked token segments per group plus the cost shown in the tooltip. Rows are
 * sorted by total tokens (desc) and capped to the top 15 to stay readable.
 */

import { useMemo } from 'react';
import type { AnalyticsGroupBy, AnalyticsRow } from '@claudescope/shared';
import {
  Bar,
  CartesianGrid,
  BarChart,
  Legend,
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
import { shortKey } from './format.js';

const MAX_BARS = 15;

interface Bucket {
  key: string;
  label: string;
  input: number;
  output: number;
  cache: number;
  cost: number;
  total: number;
}

export function BreakdownChart({
  rows,
  groupBy,
  showCache,
}: {
  rows: AnalyticsRow[];
  groupBy: AnalyticsGroupBy;
  showCache: boolean;
}) {
  const data = useMemo<Bucket[]>(
    () =>
      rows
        .map((r) => ({
          key: r.key,
          label: shortKey(r.key, groupBy),
          input: r.inputTokens,
          output: r.outputTokens,
          cache: r.cacheCreationTokens + r.cacheReadTokens,
          cost: r.costUsd,
          total: r.totalTokens,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, MAX_BARS),
    [rows, groupBy],
  );

  // Scale height with the number of bars so labels never overlap.
  const height = Math.max(220, data.length * 34 + 60);

  const { resolvedTheme } = useTheme();
  const colors = getChartColors(resolvedTheme);
  const tick = axisTick(colors);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart layout="vertical" data={data} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={colors.grid} horizontal={false} />
        <XAxis
          type="number"
          tick={tick}
          tickLine={false}
          axisLine={{ stroke: colors.grid }}
          tickFormatter={(v: number) => formatCount(v)}
        />
        <YAxis
          type="category"
          dataKey="label"
          tick={tick}
          tickLine={false}
          axisLine={{ stroke: colors.grid }}
          width={140}
          interval={0}
        />
        <Tooltip cursor={{ fill: colors.cursor }} content={<BreakdownTooltip colors={colors} />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="input" name="Input" stackId="tok" fill={colors.input} isAnimationActive={false} />
        <Bar dataKey="output" name="Output" stackId="tok" fill={colors.output} radius={showCache ? undefined : [0, 2, 2, 0]} isAnimationActive={false} />
        {showCache && (
          <Bar dataKey="cache" name="Cache" stackId="tok" fill={colors.cacheWrite} radius={[0, 2, 2, 0]} isAnimationActive={false} />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Narrow the loosely-typed recharts tooltip payload. */
function BreakdownTooltip(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: Bucket }>;
  colors: ChartColors;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) return null;
  const p = props.payload[0]?.payload;
  if (!p) return null;
  const { colors } = props;
  return (
    <TooltipCard
      title={p.key}
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
