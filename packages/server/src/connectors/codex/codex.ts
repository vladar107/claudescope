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
import { canonicalProjectionSql } from '../canonical.js';
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

function auxProjections(_filePath: string): AuxProjections {
  return {}; // Codex has no ai-title / pr-link records
}

/**
 * Load a session's events, splitting the resolved rollouts into the main thread
 * (its own thread id equals the session id) and one subagent per re-keyed child
 * rollout. A child's metadata comes from the parent's matching `spawn_agent`
 * call, correlated by the legacy child `agent_id` or current canonical
 * `task_name`/`agent_path`, so the run anchors to the exact canonical `Task`.
 */
async function loadSession(sessionId: string, paths: string[]): Promise<SessionData> {
  const sessions = paths
    .map((p) => parseRollout(p))
    .filter((s): s is CodexSession => s !== null);
  const main = sessions.find((s) => s.sessionId === sessionId);
  const subagents: SubagentSource[] = [];
  for (const s of sessions) {
    if (s === main) continue;
    const meta =
      (s.agentPath ? main?.spawnedAgents.get(s.agentPath) : undefined) ??
      main?.spawnedAgents.get(s.sessionId);
    subagents.push({
      agentId: s.sessionId,
      agentType: meta?.agentType ?? s.agentRole ?? '',
      description: meta?.description ?? s.agentPath ?? '',
      toolUseId: meta?.toolUseId,
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
  loadSession,
  globalMemory: codexGlobalMemory,
  resumeSpec: (id) => ({
    resumeArgv: ['codex', 'resume', id],
    forkArgv: ['codex', 'fork', id],
  }),
};
