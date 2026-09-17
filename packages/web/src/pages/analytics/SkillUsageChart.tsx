import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ToolUsageRow } from '@claudescope/shared';
import { useTheme } from '../../theme/ThemeProvider.js';
import { agentColor, axisTick, getChartColors, TooltipCard } from './chart-common.js';
import { formatCount } from './format.js';
import { AgentBadge, agentLabel } from '../../components/index.js';

interface SkillBar {
  skill: string;
  count: number;
  /** Calls per agent — one stacked segment each. */
  byAgent: Record<string, number>;
}

/** Rows arrive one per (skill, agent); fold them to one bar per skill, split by agent. */
function bySkill(rows: ToolUsageRow[]): { data: SkillBar[]; agents: string[] } {
  const map = new Map<string, SkillBar>();
  const totals = new Map<string, number>();
  for (const r of rows) {
    const b = map.get(r.tool) ?? { skill: r.tool, count: 0, byAgent: {} };
    b.count += r.count;
    b.byAgent[r.agent] = (b.byAgent[r.agent] ?? 0) + r.count;
    map.set(r.tool, b);
    totals.set(r.agent, (totals.get(r.agent) ?? 0) + r.count);
  }
  // Stack order = agent volume, so the biggest contributor sits at the base.
  const agents = [...totals.entries()].sort((a, z) => z[1] - a[1]).map(([agent]) => agent);
  return { data: [...map.values()].sort((a, b) => b.count - a.count), agents };
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
  const { data, agents } = bySkill(rows);
  const tick = axisTick(colors);
  const height = Math.max(140, data.length * 34 + 24);

  return (
    <>
      {agents.length > 1 ? (
        <div className="tv-skill-legend">
          {agents.map((a) => (
            <AgentBadge key={a} connectorId={a} />
          ))}
        </div>
      ) : null}
      <ResponsiveContainer width="100%" height={height}>
        <BarChart layout="vertical" data={data} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
          <CartesianGrid stroke={colors.grid} horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={tick} tickLine={false} axisLine={{ stroke: colors.grid }} tickFormatter={(v: number) => formatCount(v)} />
          <YAxis type="category" dataKey="skill" tick={tick} tickLine={false} axisLine={{ stroke: colors.grid }} width={yAxisWidth(data)} interval={0} />
          <Tooltip cursor={{ fill: colors.cursor }} content={<SkillTip theme={resolvedTheme} />} />
          {agents.map((a, i) => (
            <Bar
              key={a}
              dataKey={`byAgent.${a}`}
              name={agentLabel(a)}
              stackId="calls"
              fill={agentColor(a, resolvedTheme)}
              radius={i === agents.length - 1 ? [0, 2, 2, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}

function SkillTip(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: SkillBar }>;
  theme: 'light' | 'dark';
}) {
  if (!props.active || !props.payload?.length) return null;
  const b = props.payload[0]?.payload;
  if (!b) return null;
  const agents = Object.entries(b.byAgent).sort((a, z) => z[1] - a[1]);
  return (
    <TooltipCard
      title={`${b.skill} — ${formatCount(b.count)} calls`}
      rows={agents.map(([agent, count]) => ({
        label: agentLabel(agent),
        value: formatCount(count),
        color: agentColor(agent, props.theme),
      }))}
    />
  );
}
