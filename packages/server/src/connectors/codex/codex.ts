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

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDESCOPE_HOME, CODEX_SESSIONS_DIR } from '../../config.js';
import { sqlString } from '../../db/duckdb.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { codexGlobalMemory } from './memory.js';
import { listRollouts, parseRollout, toCanonicalRows, type CodexSession } from './normalize.js';

const CACHE_DIR = join(CLAUDESCOPE_HOME, 'cache', 'codex');

/** Deterministic temp NDJSON path for a given rollout file. */
function cachePath(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${hash}.ndjson`);
}

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
  mkdirSync(CACHE_DIR, { recursive: true });
  const rows = session ? toCanonicalRows(session, filePath) : [];
  writeFileSync(cachePath(filePath), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function eventsProjectionSql(filePath: string): string {
  const path = sqlString(cachePath(filePath));
  return `
    SELECT
      file_path, session_id, uuid, parent_uuid, role, type, ts, cwd, git_branch,
      model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      service_tier, is_sidechain, tool_use_count, tool_names, text_content,
      CAST(NULL AS VARCHAR) AS message_id, CAST(NULL AS VARCHAR) AS forked_from_session_id
    FROM read_ndjson(${path}, format='newline_delimited', maximum_object_size=268435456, ignore_errors=true, columns={
      file_path:'VARCHAR', session_id:'VARCHAR', uuid:'VARCHAR', parent_uuid:'VARCHAR',
      role:'VARCHAR', type:'VARCHAR', ts:'TIMESTAMP', cwd:'VARCHAR', git_branch:'VARCHAR',
      model:'VARCHAR', input_tokens:'BIGINT', output_tokens:'BIGINT', cache_read_tokens:'BIGINT',
      cache_write_tokens:'BIGINT', service_tier:'VARCHAR', is_sidechain:'BOOLEAN',
      tool_use_count:'INTEGER', tool_names:'VARCHAR', text_content:'VARCHAR'
    })`;
}

function auxProjections(_filePath: string): AuxProjections {
  return {}; // Codex has no ai-title / pr-link records
}

/**
 * Load a session's events, splitting the resolved rollouts into the main thread
 * (its own thread id equals the session id) and one subagent per re-keyed child
 * rollout. A child's `description`/`agentType` come from the parent's matching
 * `spawn_agent` call (correlated via the spawn output's `agent_id`), so the run
 * anchors to the canonical `Task` block.
 */
async function loadSession(sessionId: string, paths: string[]): Promise<SessionData> {
  const sessions = paths
    .map((p) => parseRollout(p))
    .filter((s): s is CodexSession => s !== null);
  const main = sessions.find((s) => s.sessionId === sessionId);
  const subagents: SubagentSource[] = [];
  for (const s of sessions) {
    if (s === main) continue;
    const meta = main?.spawnedAgents.get(s.sessionId);
    subagents.push({
      agentId: s.sessionId,
      agentType: meta?.agentType ?? s.agentRole ?? '',
      description: meta?.description ?? '',
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
  sourceDir: CODEX_SESSIONS_DIR,
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
