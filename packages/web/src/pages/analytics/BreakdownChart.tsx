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
import { AXIS_TICK, COLORS, TooltipCard, formatCost, formatCount } from './chart-common.js';
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

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart layout="vertical" data={data} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={COLORS.grid} horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: COLORS.grid }}
          tickFormatter={(v: number) => formatCount(v)}
        />
        <YAxis
          type="category"
          dataKey="label"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: COLORS.grid }}
          width={140}
          interval={0}
        />
        <Tooltip cursor={{ fill: '#ffffff0a' }} content={<BreakdownTooltip />} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="input" name="Input" stackId="tok" fill={COLORS.input} isAnimationActive={false} />
        <Bar dataKey="output" name="Output" stackId="tok" fill={COLORS.output} radius={showCache ? undefined : [0, 2, 2, 0]} isAnimationActive={false} />
        {showCache && (
          <Bar dataKey="cache" name="Cache" stackId="tok" fill={COLORS.cacheWrite} radius={[0, 2, 2, 0]} isAnimationActive={false} />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Narrow the loosely-typed recharts tooltip payload. */
function BreakdownTooltip(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: Bucket }>;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) return null;
  const p = props.payload[0]?.payload;
  if (!p) return null;
  return (
    <TooltipCard
      title={p.key}
      rows={[
        { label: 'Input', value: formatCount(p.input), color: COLORS.input },
        { label: 'Output', value: formatCount(p.output), color: COLORS.output },
        { label: 'Cache', value: formatCount(p.cache), color: COLORS.cacheWrite },
        { label: 'Total tokens', value: formatCount(p.total) },
        { label: 'Cost', value: formatCost(p.cost), color: COLORS.cost },
      ]}
    />
  );
}
