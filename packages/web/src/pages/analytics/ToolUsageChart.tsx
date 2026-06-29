import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ToolUsageRow } from '@claudescope/shared';
import { type ToolCategory, toolCategory } from '@claudescope/shared';
import { useTheme } from '../../theme/ThemeProvider.js';
import { axisTick, type ChartColors, getChartColors, TooltipCard } from './chart-common.js';
import { formatCount } from './format.js';
import { agentLabel } from '../../components/index.js';

interface Bucket {
  key: ToolCategory;
  count: number;
  /** Raw tools (name + agent + count) that fell into this category, for the tooltip. */
  tools: { tool: string; agent: string; count: number }[];
}

const CATEGORY_COLOR = (c: ChartColors): Record<ToolCategory, string> => ({
  Edit: c.output,
  Read: c.input,
  Search: c.cacheRead,
  Shell: c.cost,
  Web: c.cacheWrite,
  Subagent: c.output,
  Other: c.axis,
});

function bucketize(rows: ToolUsageRow[]): Bucket[] {
  const map = new Map<ToolCategory, Bucket>();
  for (const r of rows) {
    const key = toolCategory(r.tool);
    const b = map.get(key) ?? { key, count: 0, tools: [] };
    b.count += r.count;
    b.tools.push({ tool: r.tool, agent: r.agent, count: r.count });
    map.set(key, b);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function ToolUsageChart({ rows }: { rows: ToolUsageRow[] }) {
  const { resolvedTheme } = useTheme();
  const colors = getChartColors(resolvedTheme);
  const palette = CATEGORY_COLOR(colors);
  const data = bucketize(rows);
  const tick = axisTick(colors);
  const height = Math.max(140, data.length * 34 + 24);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart layout="vertical" data={data} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={colors.grid} horizontal={false} />
        <XAxis type="number" tick={tick} tickLine={false} axisLine={{ stroke: colors.grid }} tickFormatter={(v: number) => formatCount(v)} />
        <YAxis type="category" dataKey="key" tick={tick} tickLine={false} axisLine={{ stroke: colors.grid }} width={84} interval={0} />
        <Tooltip cursor={{ fill: colors.cursor }} content={<ToolTip palette={palette} />} />
        <Bar dataKey="count" name="Calls" radius={[0, 2, 2, 0]} isAnimationActive={false}>
          {data.map((b) => (
            <Cell key={b.key} fill={palette[b.key]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function ToolTip(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: Bucket }>; palette: Record<ToolCategory, string> }) {
  if (!props.active || !props.payload?.length) return null;
  const b = props.payload[0]?.payload;
  if (!b) return null;
  const top = [...b.tools].sort((a, z) => z.count - a.count).slice(0, 6);
  return (
    <TooltipCard
      title={`${b.key} — ${formatCount(b.count)} calls`}
      rows={top.map((t) => ({ label: `${t.tool} · ${agentLabel(t.agent)}`, value: formatCount(t.count), color: props.palette[b.key] }))}
    />
  );
}
