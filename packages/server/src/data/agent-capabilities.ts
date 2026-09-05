/**
 * What each agent's source format can and cannot tell us — properties of the
 * CONNECTOR, not of the data (see the per-connector gotchas in CLAUDE.md).
 * Consulted wherever a metric must read "unavailable" rather than 0 for an
 * agent that never records it.
 */

import type { AgentUsageGranularity } from '@claudescope/shared';

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
