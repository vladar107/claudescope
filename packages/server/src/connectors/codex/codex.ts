/**
 * OpenAI Codex CLI connector.
 *
 * Source layout: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Codex spreads a
 * session across record types, so it can't be projected per-row by DuckDB.
 * Instead `prepare()` normalizes a rollout to a canonical NDJSON (in TS, via
 * {@link parseRollout}/{@link toCanonicalRows}) and `eventsProjectionSql` reads
 * that 1:1 — the indexer/FTS/cost stay native and Claude's path is untouched.
 *
 * Subagents are separate rollouts (`thread_source: "subagent"`) re-keyed under
 * their root session at prepare time, so `loadSession` splits the resolved files
 * into the main transcript and one {@link SubagentSource} per child, which the
 * thread assembler nests at the parent's `spawn_agent` (→ `Task`) call.
 *
 * STRICTLY READ-ONLY with respect to ~/.codex — files are only ever read.
 */

import { codexSessionsDir } from '../../settings.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { canonicalProjectionSql, compactionsProjectionSql } from '../canonical.js';
import { ndjsonCache } from '../ndjson-cache.js';
import { codexGlobalMemory } from './memory.js';
import { listRollouts, parseRollout, toCanonicalRows, type CodexSession } from './normalize.js';

const cache = ndjsonCache('codex');

/**
 * Every `rollout-*.jsonl` under the Codex sessions dir. Subagent rollouts are
 * included as ordinary files — they re-key to their root session at prepare time.
 * Unlike antigravity, no mtime folding is needed: a child's parent link lives in
 * its OWN `session_meta` from creation, so it never changes after the fact.
 */
function discover(): DiscoveredFile[] {
  return listRollouts();
}

/** Normalize a rollout to canonical NDJSON the projection will read. */
async function prepare(filePath: string): Promise<void> {
  const session = parseRollout(filePath);
  const rows = session ? toCanonicalRows(session, filePath) : [];
  cache.write(filePath, rows);
}

function eventsProjectionSql(filePath: string): string {
  return canonicalProjectionSql(cache.path(filePath), { provider: true });
}

/** Codex has no ai-title / pr-link records — only the compaction markers the
 *  normalizer wrote into the cache. */
function auxProjections(filePath: string): AuxProjections {
  return { compactions: compactionsProjectionSql(cache.path(filePath)) };
}

/**
 * Codex records its injected AGENTS/environment bootstrap with a USER role, so
 * a session's first user message is frequently the preamble rather than the
 * prompt. This strips only the complete, leading wrapper — the `# AGENTS.md
 * instructions` header through `</INSTRUCTIONS>`, then an `<environment_context>`
 * block if one follows, or a bare `<environment_context>` prefix — so a
 * bootstrap-only message falls away (empty candidate → the indexer moves to the
 * next message) while a prompt coalesced into the same event survives.
 * Unfamiliar or malformed shapes fall back to the raw text, untouched.
 */
function fallbackTitleCandidateSql(sourceExpr: string, textExpr: string): string {
  const remainder = `substring(${sourceExpr}, strpos(${sourceExpr}, '</INSTRUCTIONS>') + length('</INSTRUCTIONS>'))`;
  // The remainder keeps the wrapper's trailing newlines; trim them before
  // testing for the environment block that may follow.
  const trimmed = `ltrim(${remainder}, chr(9) || chr(10) || chr(13) || ' ')`;
  const afterEnvironment = (expr: string) =>
    `substring(${expr}, strpos(${expr}, '</environment_context>') + length('</environment_context>'))`;
  return `
    CASE
      WHEN regexp_matches(
             ${sourceExpr},
             '^# AGENTS\\.md instructions(?: for [^\\r\\n]+)?\\r?\\n[\\t\\r\\n ]*<INSTRUCTIONS>'
           )
        AND strpos(${sourceExpr}, '<INSTRUCTIONS>') > 0
        AND strpos(${sourceExpr}, '</INSTRUCTIONS>') > strpos(${sourceExpr}, '<INSTRUCTIONS>')
      THEN
        CASE
          WHEN starts_with(${trimmed}, '<environment_context>') THEN
            CASE
              WHEN strpos(${trimmed}, '</environment_context>') > length('<environment_context>')
              THEN ${afterEnvironment(trimmed)}
              ELSE ${textExpr}
            END
          ELSE ${remainder}
        END
      WHEN starts_with(${sourceExpr}, '<environment_context>')
        AND strpos(${sourceExpr}, '</environment_context>') > length('<environment_context>')
      THEN ${afterEnvironment(sourceExpr)}
      ELSE ${textExpr}
    END`;
}

/**
 * Load a session's events, splitting the resolved rollouts into the main thread
 * (its own thread id equals the session id) and one subagent per re-keyed child
 * rollout. A child's metadata comes from the matching `spawn_agent` call,
 * correlated by the legacy child `agent_id` or current canonical
 * `task_name`/`agent_path`, so the run anchors to the exact canonical `Task`.
 *
 * A spawn record lives in the rollout that made the call, so a subagent spawned
 * by a subagent is described by the DEPTH-1 child's rollout, not the root's —
 * hence the merged spawn map plus the `parent_thread_id` pointer.
 */
async function loadSession(sessionId: string, paths: string[]): Promise<SessionData> {
  const sessions = paths
    .map((p) => parseRollout(p))
    .filter((s): s is CodexSession => s !== null);
  const main = sessions.find((s) => s.sessionId === sessionId);
  // Root first, so it wins a key collision with a child's own spawn record.
  const ordered = main ? [main, ...sessions.filter((s) => s !== main)] : sessions;
  const spawned = new Map<string, { description: string; agentType: string; toolUseId: string }>();
  for (const s of ordered) {
    for (const [key, meta] of s.spawnedAgents) if (!spawned.has(key)) spawned.set(key, meta);
  }
  const childIds = new Set(sessions.filter((s) => s !== main).map((s) => s.sessionId));
  const subagents: SubagentSource[] = [];
  for (const s of sessions) {
    if (s === main) continue;
    const meta = (s.agentPath ? spawned.get(s.agentPath) : undefined) ?? spawned.get(s.sessionId);
    // Only a parent that is itself a child is passed on — the root is implied.
    const parentAgentId =
      s.parentThreadId && childIds.has(s.parentThreadId) ? s.parentThreadId : undefined;
    subagents.push({
      agentId: s.sessionId,
      agentType: meta?.agentType ?? s.agentRole ?? '',
      description: meta?.description ?? s.agentPath ?? '',
      toolUseId: meta?.toolUseId,
      ...(parentAgentId ? { parentAgentId } : {}),
      events: s.events,
    });
  }
  const mainEvents = main?.events ?? [];
  // Fallback: a session whose parent rollout is missing (deleted, or never
  // existed) would render an empty main thread — promote the children instead.
  if (mainEvents.length === 0 && subagents.length > 0) {
    return { mainEvents: subagents.flatMap((s) => s.events), subagents: [] };
  }
  return { mainEvents, subagents };
}

export const codexConnector: AgentConnector = {
  id: 'codex',
  label: 'Codex',
  // Resolved per access so a settings.json change applies without a restart.
  get sourceDir() {
    return codexSessionsDir();
  },
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  fallbackTitleCandidateSql,
  loadSession,
  globalMemory: codexGlobalMemory,
  resumeSpec: (id) => ({
    resumeArgv: ['codex', 'resume', id],
    forkArgv: ['codex', 'fork', id],
  }),
};
