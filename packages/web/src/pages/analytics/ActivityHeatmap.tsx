import type { ActivityResponse } from '@claudescope/shared';

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // isodow 1..7
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** GitHub-punchcard heatmap of user prompts by local day-of-week × hour, plus
 *  a current/longest streak readout. Intensity uses the accent color mixed with
 *  the surface, so it tracks the active theme. */
export function ActivityHeatmap({ data }: { data: ActivityResponse }) {
  // index: dow(1..7) -> hour(0..23) -> count
  const counts = new Map<string, number>();
  let max = 0;
  for (const c of data.heatmap) {
    counts.set(`${c.dow}:${c.hour}`, c.count);
    if (c.count > max) max = c.count;
  }
  const cellBg = (count: number): string => {
    if (count <= 0) return 'var(--tv-bg-inset)';
    const pct = Math.round(15 + 85 * (max > 0 ? count / max : 0));
    return `color-mix(in srgb, var(--tv-accent) ${pct}%, transparent)`;
  };

  return (
    <div className="tv-heatmap">
      <div className="tv-heatmap__streaks">
        <span className="tv-heatmap__streak">🔥 {data.streak.current}-day streak</span>
        <span className="tv-heatmap__streak-sub">longest {data.streak.longest}</span>
      </div>
      <div className="tv-heatmap__grid" role="img" aria-label="Activity by day and hour">
        {DOW_LABELS.map((label, i) => {
          const dow = i + 1;
          return (
            <div className="tv-heatmap__row" key={dow}>
              <span className="tv-heatmap__rowlabel">{label}</span>
              {HOURS.map((hour) => {
                const count = counts.get(`${dow}:${hour}`) ?? 0;
                return (
                  <span
                    key={hour}
                    className="tv-heatmap__cell"
                    style={{ backgroundColor: cellBg(count) }}
                    title={`${label} ${String(hour).padStart(2, '0')}:00 — ${count} prompt${count === 1 ? '' : 's'}`}
                  />
                );
              })}
            </div>
          );
        })}
        <div className="tv-heatmap__hours">
          <span className="tv-heatmap__rowlabel" />
          {HOURS.map((h) => (
            <span className="tv-heatmap__hourlabel" key={h}>
              {h % 6 === 0 ? h : ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
