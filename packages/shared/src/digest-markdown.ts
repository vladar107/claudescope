/**
 * Render a digest (GET /api/analytics/digest) to Markdown — shared by the web
 * "Copy as Markdown" button and the `claudescope digest` CLI so both emit the
 * same document. Pure; sections with nothing to say are omitted.
 */

import type { DigestResponse } from './api.js';

const cost = (usd: number): string => `$${usd.toFixed(2)}`;
const num = (n: number): string => n.toLocaleString('en-US');
const day = (iso: string): string => iso.slice(0, 10);
const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

export function digestToMarkdown(d: DigestResponse): string {
  const out: string[] = [`# Week in review — ${day(d.from)} → ${day(d.to)}`, ''];

  if (d.totals.sessions === 0) {
    out.push('_No sessions in range._');
    return out.join('\n') + '\n';
  }

  const t = d.totals;
  out.push(
    `**${num(t.sessions)}** sessions across **${num(t.activeProjects)}** projects · ` +
      `${num(t.responses)} responses · ${num(t.totalTokens)} tokens · ${cost(t.costUsd)}`,
    '',
    '_Cost is a list-price estimate; token/cost totals cover only agents that report usage._',
  );

  if (d.topProjects.length > 0) {
    out.push('', '## Top projects', '');
    for (const p of d.topProjects) {
      out.push(`- **${p.cwd || '(unknown)'}** — ${p.sessions} sessions · ${num(p.totalTokens)} tok · ${cost(p.costUsd)}`);
    }
  }

  if (d.impact.edits > 0) {
    out.push(
      '',
      '## Code impact',
      '',
      `+${num(d.impact.additions)} / −${num(d.impact.deletions)} lines over ` +
        `${num(d.impact.filesTouched)} files (${num(d.impact.edits)} edits, agent-reported)`,
    );
    if (d.impact.topFiles.length > 0) {
      out.push('');
      for (const f of d.impact.topFiles) {
        out.push(`- \`${f.path}\` (+${num(f.additions)}/−${num(f.deletions)})`);
      }
    }
  }

  if (d.agents.length > 0) {
    out.push('', '## Agents', '');
    out.push(d.agents.map((a) => `${a.key} ×${a.count}`).join(' · '));
  }

  if (d.models.length > 0) {
    out.push('', '## Models', '');
    out.push(d.models.map((m) => `${m.key} (${num(m.count)})`).join(' · '));
  }

  if (d.topTools.length > 0) {
    out.push('', '## Top tools', '');
    out.push(d.topTools.map((tl) => `${tl.key} (${num(tl.count)})`).join(' · '));
  }

  const reliability: string[] = [];
  if (d.errors) {
    const rate = d.errors.errorRate === null ? 'n/a' : pct(d.errors.errorRate);
    reliability.push(
      `- Tool errors: ${num(d.errors.toolErrors)} of ${num(d.errors.toolCalls)} calls (${rate})` +
        (d.errors.unknownAgents.length > 0 ? ` — no signal from ${d.errors.unknownAgents.join(', ')}` : ''),
    );
  }
  if (d.interrupts !== null) {
    reliability.push(`- Interrupts (Claude Code): ${num(d.interrupts)}`);
  }
  if (reliability.length > 0) {
    out.push('', '## Reliability', '', ...reliability);
  }

  const momentum: string[] = [];
  if (d.streak.current > 0 || d.streak.longest > 0) {
    momentum.push(`- Prompt streak: ${d.streak.current} days (longest ${d.streak.longest})`);
  }
  if (d.biggestSession) {
    const b = d.biggestSession;
    momentum.push(
      `- Biggest session: “${b.title}” [${b.connectorId}] — ${num(b.totalTokens)} tok · ${cost(b.costUsd)}`,
    );
  }
  if (momentum.length > 0) {
    out.push('', '## Momentum', '', ...momentum);
  }

  return out.join('\n') + '\n';
}
