/**
 * What each agent's source format can and cannot tell us — properties of the
 * CONNECTOR, not of the data (see the per-connector gotchas in CLAUDE.md).
 * Consulted wherever a metric must read "unavailable" rather than 0 for an
 * agent that never records it.
 */

import type { AgentUsageGranularity } from '@claudescope/shared';

/**
 * The agent a row with no recorded `connector_id` belongs to. Claude Code was
 * the only source before the column existed, so a legacy/NULL id is its row —
 * a fallback for stored data, never a guess about an unknown agent.
 */
export const DEFAULT_CONNECTOR_ID = 'claude-code';

/**
 * How each agent records token usage:
 * - copilot: tokens live only in `session.shutdown`, attached to the last
 *   assistant row — session totals are real, per-response ratios are not, and
 *   crashed/still-running sessions (no shutdown) carry no usage at all.
 * - antigravity: transcripts carry no token counts by design.
 * Unknown connectors default to per-response (the canonical event contract
 * carries per-event tokens).
 */
const USAGE_GRANULARITY: Record<string, AgentUsageGranularity> = {
  'claude-code': 'per-response',
  codex: 'per-response',
  pi: 'per-response',
  opencode: 'per-response',
  junie: 'per-response',
  copilot: 'session-level',
  antigravity: 'none',
  grok: 'per-response',
};

export function usageGranularity(connectorId: string): AgentUsageGranularity {
  return USAGE_GRANULARITY[connectorId] ?? 'per-response';
}

/**
 * Agents whose assistant rows carry ONE prompt's usage, so a row's
 * `input + cache read + cache write` is a context size. Not the same thing as
 * per-response granularity: Junie sums every LLM call of an agentic loop into
 * the turn's single row, and Grok attaches one `turn_completed` total per user
 * turn — real totals, but a "context" read from them would be a fabrication
 * (a long Junie turn exceeds any model's window). Unknown connectors are NOT
 * assumed to qualify: a wrong absence is a missing figure, a wrong presence is
 * a wrong one.
 */
const PROMPT_SIZED_USAGE = new Set(['claude-code', 'codex', 'pi', 'opencode']);

export function hasPromptSizedUsage(connectorId: string): boolean {
  return PROMPT_SIZED_USAGE.has(connectorId);
}

export function connectorsWithPromptSizedUsage(): string[] {
  return [...PROMPT_SIZED_USAGE];
}

/**
 * Agents whose format records a context-compaction marker: Claude Code
 * (`system`/`compact_boundary`, or the 2025 `isCompactSummary` user turn),
 * Codex (`compacted` rollout record), pi (`compaction` entry), Copilot
 * (`session.context_changed` with reason `compaction`). For every other agent
 * a compaction count of 0 means "unknown", so the API omits it.
 */
const COMPACTION_SIGNAL = new Set(['claude-code', 'codex', 'pi', 'copilot']);

export function hasCompactionSignal(connectorId: string): boolean {
  return COMPACTION_SIGNAL.has(connectorId);
}

export function connectorsWithCompactionSignal(): string[] {
  return [...COMPACTION_SIGNAL];
}

/**
 * Agents whose format marks a tool call as FAILED, so `events.tool_error_count`
 * carries a real number: Claude Code (`tool_result.is_error`, derived in SQL),
 * Codex (`is_error` plus the exec/custom envelope's exit code), pi
 * (`toolResult.isError`), opencode (`state.status === 'error'`), Copilot
 * (`tool.execution_complete.success === false`). Junie's "modified: path" result
 * strings, Antigravity's typed result records and Grok's bare `tool_result`
 * bodies carry no such flag — their normalizers emit NULL so analytics reads
 * "unavailable" rather than a fabricated 0.
 */
const TOOL_ERROR_SIGNAL = new Set(['claude-code', 'codex', 'pi', 'opencode', 'copilot']);

/** The other side of {@link TOOL_ERROR_SIGNAL} — every remaining connector must
 *  be listed here, so adding an agent forces a deliberate classification
 *  (enforced by `connector-error-signal.test.ts`). */
const NO_TOOL_ERROR_SIGNAL = new Set(['junie', 'antigravity', 'grok']);

export function hasToolErrorSignal(connectorId: string): boolean {
  return TOOL_ERROR_SIGNAL.has(connectorId);
}

export function connectorsWithToolErrorSignal(): string[] {
  return [...TOOL_ERROR_SIGNAL];
}

export function connectorsWithoutToolErrorSignal(): string[] {
  return [...NO_TOOL_ERROR_SIGNAL];
}

/**
 * Agents whose format records a user interrupt: Claude Code writes the
 * `[Request interrupted by user…]` marker as the user message's text. No other
 * source persists the event at all, so their interrupt count is `null`
 * ("unavailable"), never the 0 a marker search would produce.
 */
const INTERRUPT_SIGNAL = new Set(['claude-code']);

export function hasInterruptSignal(connectorId: string): boolean {
  return INTERRUPT_SIGNAL.has(connectorId);
}

/**
 * Agents whose transcripts link a subagent run back to the session that spawned
 * it. Junie delegates by running `junie …` as a plain terminal command, so its
 * children are independent sessions with zero ID linkage (see CLAUDE.md) — a
 * subagent share derived for it would report 0 delegation, not "unknown".
 * Unknown connectors are assumed to have linkage: that is the canonical shape.
 */
const NO_SUBAGENT_LINKAGE = new Set(['junie']);

export function hasSubagentLinkage(connectorId: string): boolean {
  return !NO_SUBAGENT_LINKAGE.has(connectorId);
}

/**
 * Why an agent's usage figures read n/a (or skewed) on the agent comparison —
 * the human sentence behind {@link usageGranularity} and the nulls around it.
 * A property of the source format, so it lives here rather than in the route.
 */
const USAGE_AVAILABILITY_NOTES: Record<string, string> = {
  copilot:
    'Copilot records usage once per session (at shutdown), so per-response ratios are unavailable; crashed or still-running sessions carry no usage.',
  antigravity:
    'Antigravity transcripts carry no token counts — tokens and cost are unavailable by design.',
  junie: 'Junie delegates via plain terminal commands, so subagent usage is invisible.',
  grok: 'Grok records usage once per user turn (in updates.jsonl); a session whose updates file is missing or truncated reports zero tokens.',
};

export function usageAvailabilityNote(connectorId: string): string | undefined {
  return USAGE_AVAILABILITY_NOTES[connectorId];
}

/** The same, for the error/interrupt signals (see {@link hasToolErrorSignal}). */
const ERROR_AVAILABILITY_NOTES: Record<string, string> = {
  junie: 'Junie tool results are plain strings — the format has no error signal.',
  antigravity: 'Antigravity result records carry no error signal.',
  copilot: 'Copilot counts permission-denied calls as errors.',
};

export function errorAvailabilityNote(connectorId: string): string | undefined {
  return ERROR_AVAILABILITY_NOTES[connectorId];
}
