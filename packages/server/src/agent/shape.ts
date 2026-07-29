/**
 * Output shaping shared by the agent-facing consumers — the MCP tools and the
 * CLI query subcommands. Everything here renders API responses to compact
 * text/Markdown sized for an agent's context window (or a terminal); nothing
 * talks to the network.
 */

import type { AnalyticsResponse, SearchResponse, SessionDetailResponse } from '@claudescope/shared';
import { redactText, threadItemsToMarkdown } from '@claudescope/shared';

/** Default hits/rows returned by the list-shaped tools/commands. */
export const DEFAULT_LIMIT = 20;
/** Default per-tool-payload char cap in session output. */
export const DEFAULT_MAX_TOOL_CHARS = 2000;
/** Default turns per session window when no windowing params are given. */
export const DEFAULT_TURNS = 20;

export const fmtCost = (usd: number): string => `$${usd.toFixed(2)}`;
export const fmtTokens = (n: number): string => n.toLocaleString('en-US');
export const day = (iso: string): string => iso.slice(0, 10);

/** Windowing params a session request may carry. */
export interface WindowArgs {
  offset?: number;
  limit?: number;
  around?: string;
  radius?: number;
}

/**
 * Resolve the window for a session request. With no windowing params at all,
 * default to the first {@link DEFAULT_TURNS} turns so a huge session never dumps
 * whole into an agent's context (or a terminal); otherwise pass the caller's
 * params through untouched.
 *
 * Shared so the MCP `get_session` tool and `claudescope session` cannot drift —
 * they had the same block copied, with a comment on one saying "same defaulting
 * as the MCP get_session tool".
 */
export function resolveWindowArgs(args: WindowArgs): WindowArgs {
  const unwindowed =
    args.around === undefined && args.offset === undefined && args.limit === undefined;
  return unwindowed
    ? { offset: 0, limit: DEFAULT_TURNS }
    : { offset: args.offset, limit: args.limit, around: args.around, radius: args.radius };
}

/** The one-line totals summary appended to analytics output. */
export function analyticsTotalsLine(totals: AnalyticsResponse['totals']): string {
  return (
    `Total: ${fmtTokens(totals.totalTokens)} tok · ${fmtCost(totals.costUsd)} · ` +
    `${totals.messageCount} responses · cache hit ${(totals.cacheHitRatio * 100).toFixed(0)}%`
  );
}

/**
 * Search hits as compact text: transcript hits carry the sessionId +
 * messageUuid needed to open them windowed (`around`), memory hits their
 * source path. Snippets are expected in `format: 'plain'`.
 */
export function shapeSearchResults(res: SearchResponse, limit: number): string {
  const sessions = res.sessions.slice(0, limit);
  const memory = res.memory.slice(0, limit);
  if (sessions.length === 0 && memory.length === 0) return 'No matches.';

  const parts: string[] = [];
  if (sessions.length > 0) {
    parts.push(
      `${sessions.length} transcript hit(s):`,
      ...sessions.map(
        (h) =>
          `- [${h.role}] ${h.title} (session ${h.sessionId}, project ${h.projectId}, uuid ${h.messageUuid})\n` +
          `  "${h.snippet}"`,
      ),
    );
  }
  if (memory.length > 0) {
    parts.push(
      `${memory.length} memory hit(s):`,
      ...memory.map(
        (h) =>
          `- ${h.title}${h.category ? ` (${h.category})` : ''} [${h.connectorId}] — ${h.sourcePath}\n` +
          `  "${h.snippet}"`,
      ),
    );
  }
  return parts.join('\n');
}

/**
 * One session (or a window of it) as compact Markdown: a header with ids and
 * totals, the paging line when the response is windowed, then the turns and
 * any subagent runs inside the window. `redact` masks home paths and likely
 * secrets in the rendered text (the caller decides; --json/raw output skips it).
 */
export function shapeSessionMarkdown(data: SessionDetailResponse, redact: boolean): string {
  const { meta, window } = data;
  const r = redact ? redactText : (s: string) => s;
  const head = [
    `# ${r(meta.title)}`,
    `session ${meta.id} [${meta.connectorId}] · project ${meta.projectDisplayName} · ` +
      `${meta.startedAt} → ${meta.endedAt} · ${fmtTokens(meta.totalTokens)} tok · ${fmtCost(meta.totalCostUsd)}`,
  ];
  if (window) {
    const end = window.offset + window.limit;
    head.push(
      `Turns ${window.offset + 1}–${end} of ${window.total}` +
        (window.anchorFound === false ? ' (around uuid not found — showing the start)' : '') +
        (end < window.total ? ` — page on with {offset: ${end}}` : ''),
    );
  }

  const opts = { redact };
  const parts = [head.join('\n'), '---', threadItemsToMarkdown(data.thread, opts)];
  for (const run of data.subagents) {
    parts.push(
      `--- subagent · ${run.agentType} — ${r(run.description || run.agentId)} ---`,
      threadItemsToMarkdown(run.thread, opts),
    );
  }
  return parts.join('\n\n');
}
