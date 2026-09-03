import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ToolUsageRow } from '@claudescope/shared';
import { useTheme } from '../../theme/ThemeProvider.js';
import { axisTick, getChartColors, TooltipCard } from './chart-common.js';
import { formatCount } from './format.js';
import { agentLabel } from '../../components/index.js';

interface SkillBar {
  skill: string;
  count: number;
  /** Per-agent split of the calls, for the tooltip. */
  agents: { agent: string; count: number }[];
}

/** Rows arrive one per (skill, agent); fold them to one bar per skill. */
function bySkill(rows: ToolUsageRow[]): SkillBar[] {
  const map = new Map<string, SkillBar>();
  for (const r of rows) {
    const b = map.get(r.tool) ?? { skill: r.tool, count: 0, agents: [] };
    b.count += r.count;
    b.agents.push({ agent: r.agent, count: r.count });
    map.set(r.tool, b);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** Skill names are `plugin:skill` and can be long; size the axis to the
 *  longest label instead of clipping it, within a cap. */
function yAxisWidth(data: SkillBar[]): number {
  const longest = Math.max(0, ...data.map((d) => d.skill.length));
  return Math.min(240, Math.max(84, 16 + longest * 7));
}

export function SkillUsageChart({ rows }: { rows: ToolUsageRow[] }) {
  const { resolvedTheme } = useTheme();
  const colors = getChartColors(resolvedTheme);
  const data = bySkill(rows);
  const tick = axisTick(colors);
  const height = Math.max(140, data.length * 34 + 24);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart layout="vertical" data={data} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
        <CartesianGrid stroke={colors.grid} horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={tick} tickLine={false} axisLine={{ stroke: colors.grid }} tickFormatter={(v: number) => formatCount(v)} />
        <YAxis type="category" dataKey="skill" tick={tick} tickLine={false} axisLine={{ stroke: colors.grid }} width={yAxisWidth(data)} interval={0} />
        <Tooltip cursor={{ fill: colors.cursor }} content={<SkillTip color={colors.output} />} />
        <Bar dataKey="count" name="Calls" fill={colors.output} radius={[0, 2, 2, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function SkillTip(props: { active?: boolean; payload?: ReadonlyArray<{ payload?: SkillBar }>; color: string }) {
  if (!props.active || !props.payload?.length) return null;
  const b = props.payload[0]?.payload;
  if (!b) return null;
  const agents = [...b.agents].sort((a, z) => z.count - a.count);
  return (
    <TooltipCard
      title={`${b.skill} — ${formatCount(b.count)} calls`}
      rows={agents.map((a) => ({ label: agentLabel(a.agent), value: formatCount(a.count), color: props.color }))}
    />
  );
}
