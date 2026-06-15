/**
 * Horizontal breakdown bars for the active group-by (project | model | day).
 *
 * Two independent controls, supplied by the page:
 *   - `metric` — what the bars render: stacked token segments (input/output/
 *     cache) or a single cost bar. The x-axis units follow suit.
 *   - `sortBy` — how rows are ordered (desc): by cost, or by the visible token
 *     sum (total with cache shown, otherwise input + output).
 * Either way the full token + cost breakdown stays in the tooltip, and the list
 * is capped to the top 15 to stay readable.
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

/** What the bars render. */
export type BreakdownMetric = 'tokens' | 'cost';
/** How rows are ordered (descending). */
export type BreakdownSort = 'tokens' | 'cost';

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
  metric,
  sortBy,
}: {
  rows: AnalyticsRow[];
  groupBy: AnalyticsGroupBy;
  showCache: boolean;
  metric: BreakdownMetric;
  sortBy: BreakdownSort;
}) {
  // Order by the chosen sort key. For tokens, sort by what the bars actually
  // render: with cache hidden, ordering by the full total would shuffle the
  // visible (input + output) bar lengths.
  const data = useMemo<Bucket[]>(() => {
    const sortVal = (b: Bucket) =>
      sortBy === 'cost' ? b.cost : showCache ? b.total : b.input + b.output;
    return rows
      .map((r) => ({
        key: r.key,
        label: shortKey(r.key, groupBy),
        input: r.inputTokens,
        output: r.outputTokens,
        cache: r.cacheCreationTokens + r.cacheReadTokens,
        cost: r.costUsd,
        total: r.totalTokens,
      }))
      .sort((a, b) => sortVal(b) - sortVal(a))
      .slice(0, MAX_BARS);
  }, [rows, groupBy, showCache, sortBy]);

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
          tickFormatter={(v: number) => (metric === 'cost' ? formatCost(v) : formatCount(v))}
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
        {metric === 'cost' && (
          <Bar dataKey="cost" name="Cost" fill={colors.cost} radius={[0, 2, 2, 0]} isAnimationActive={false} />
        )}
        {metric === 'tokens' && (
          <Bar dataKey="input" name="Input" stackId="tok" fill={colors.input} isAnimationActive={false} />
        )}
        {metric === 'tokens' && (
          <Bar dataKey="output" name="Output" stackId="tok" fill={colors.output} radius={showCache ? undefined : [0, 2, 2, 0]} isAnimationActive={false} />
        )}
        {metric === 'tokens' && showCache && (
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
