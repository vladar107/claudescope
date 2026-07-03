/**
 * Week-in-review digest (Analytics → Digest): stat cards + short lists over
 * the selected range, with a "Copy as Markdown" button that emits the exact
 * document `claudescope digest` prints (shared renderer in
 * `@claudescope/shared`). Range presets set the page's from/to inputs, so the
 * digest range and the shared date fields stay one source of truth.
 */
import { useState } from 'react';
import type { DigestResponse } from '@claudescope/shared';
import { digestToMarkdown } from '@claudescope/shared';
import { AgentBadge } from '../../components/index.js';
import { formatCount, formatCost, formatPct } from './format.js';

/** Monday of the week containing `d` (local). */
function mondayOf(d: Date): Date {
  const out = new Date(d);
  out.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return out;
}
const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface DigestPreset {
  label: string;
  from: string;
  to: string;
}

/** "This week" (Monday → today) and "Last week" (previous Monday → Sunday). */
export function digestPresets(now = new Date()): DigestPreset[] {
  const monday = mondayOf(now);
  const lastMonday = new Date(monday);
  lastMonday.setDate(monday.getDate() - 7);
  const lastSunday = new Date(monday);
  lastSunday.setDate(monday.getDate() - 1);
  return [
    { label: 'This week', from: isoDay(monday), to: isoDay(now) },
    { label: 'Last week', from: isoDay(lastMonday), to: isoDay(lastSunday) },
  ];
}

export function DigestView({
  data,
  onRange,
}: {
  data: DigestResponse;
  onRange: (from: string, to: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(digestToMarkdown(data)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const t = data.totals;
  const day = (iso: string) => iso.slice(0, 10);

  return (
    <div className="tv-digest">
      <div className="tv-digest__bar">
        <div className="tv-segmented tv-segmented--sm" role="group" aria-label="Range preset">
          {digestPresets().map((p) => (
            <button
              key={p.label}
              type="button"
              className="tv-segmented__btn"
              onClick={() => onRange(p.from, p.to)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="tv-eff__hint">
          {day(data.from)} → {day(data.to)}
        </span>
        <button type="button" className="tv-analytics__clear" onClick={copy}>
          {copied ? 'Copied ✓' : 'Copy as Markdown'}
        </button>
      </div>

      {t.sessions === 0 ? (
        <div className="tv-card tv-chart-empty">No sessions in range.</div>
      ) : (
        <>
          <div className="tv-analytics__cards">
            <Stat label="Sessions" value={formatCount(t.sessions)} sub={`${t.activeProjects} projects · ${formatCount(t.responses)} responses`} />
            <Stat label="Cost" value={formatCost(t.costUsd)} sub={`${formatCount(t.totalTokens)} tokens · usage-reporting agents only`} />
            <Stat
              label="Code impact"
              value={`+${formatCount(data.impact.additions)} / −${formatCount(data.impact.deletions)}`}
              sub={`${formatCount(data.impact.filesTouched)} files · ${formatCount(data.impact.edits)} edits · agent-reported`}
            />
            <Stat
              label="Streak"
              value={`${data.streak.current}d`}
              sub={`longest ${data.streak.longest}d${data.errors ? ` · tool errors ${data.errors.errorRate === null ? 'n/a' : formatPct(data.errors.errorRate)}` : ''}${data.interrupts !== null ? ` · ${data.interrupts} interrupts` : ''}`}
            />
          </div>

          <div className="tv-analytics__charts">
            <ListCard title="Top projects" hint="by cost">
              {data.topProjects.map((p) => (
                <li key={p.projectId || '(unknown)'}>
                  <code>{p.cwd || '(unknown)'}</code> — {p.sessions} sessions · {formatCount(p.totalTokens)} tok ·{' '}
                  {formatCost(p.costUsd)}
                </li>
              ))}
            </ListCard>

            <ListCard title="Most-churned files" hint="agent-reported, not git truth">
              {data.impact.topFiles.length === 0 ? (
                <li className="tv-digest__empty">No edits in range.</li>
              ) : (
                data.impact.topFiles.map((f) => (
                  <li key={f.path}>
                    <code>{f.path}</code> (+{formatCount(f.additions)}/−{formatCount(f.deletions)})
                  </li>
                ))
              )}
            </ListCard>

            <ListCard title="Agents & models" hint="sessions per agent · responses per model">
              <li>
                {data.agents.map((a) => (
                  <span key={a.key} className="tv-digest__agent">
                    <AgentBadge connectorId={a.key} /> ×{a.count}{' '}
                  </span>
                ))}
              </li>
              <li>{data.models.map((m) => `${m.key} (${formatCount(m.count)})`).join(' · ')}</li>
            </ListCard>

            <ListCard title="Highlights" hint="top tools · biggest session">
              <li>{data.topTools.map((tl) => `${tl.key} (${formatCount(tl.count)})`).join(' · ') || '—'}</li>
              {data.biggestSession && (
                <li>
                  Biggest session: “{data.biggestSession.title}” — {formatCount(data.biggestSession.totalTokens)} tok
                  · {formatCost(data.biggestSession.costUsd)}
                </li>
              )}
            </ListCard>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tv-card tv-stat-card">
      <span className="tv-stat-card__label">{label}</span>
      <span className="tv-stat-card__value">{value}</span>
      {sub && <span className="tv-stat-card__sub">{sub}</span>}
    </div>
  );
}

function ListCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="tv-card tv-chart-card">
      <div className="tv-chart-card__head">
        <div className="tv-chart-card__heading">
          <h2 className="tv-chart-card__title">{title}</h2>
          {hint && <span className="tv-chart-card__hint">{hint}</span>}
        </div>
      </div>
      <ul className="tv-digest__list">{children}</ul>
    </section>
  );
}
