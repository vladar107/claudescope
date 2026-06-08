/**
 * Loads the raw events of a single session for the session-detail endpoint.
 *
 * File lookup is via the `files` table (authoritative — the indexer records the
 * real on-disk path), so this stays agent-agnostic: it resolves the session's
 * files, then delegates the format-specific reading/normalization to the owning
 * {@link AgentConnector}. The connector returns the main transcript events
 * separately from each subagent's events (plus metadata), so the thread
 * assembler can present subagents nested at their spawn point.
 */

import type { RawEvent } from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { connectorForSession } from '../connectors/registry.js';

/** One subagent transcript: its metadata plus its raw events. */
export interface SubagentSource {
  agentId: string;
  agentType: string;
  description: string;
  slug?: string;
  /**
   * Workflow run id (e.g. `wf_…`) when this agent was spawned by a `Workflow`
   * tool call — derived from its `subagents/workflows/<wfId>/` path. Lets the
   * builder nest all of a workflow's agents under that one tool call.
   */
  workflowId?: string;
  events: RawEvent[];
}

/** A session's events split into the main transcript and its subagent runs. */
export interface SessionData {
  mainEvents: RawEvent[];
  subagents: SubagentSource[];
}

/**
 * Resolve a session's files from the index and delegate reading to its owning
 * connector. Returns empty collections if the session is unknown.
 */
export async function loadSessionData(sessionId: string): Promise<SessionData> {
  const conn = await getConnection();
  const rows = await queryRows(
    conn,
    `SELECT path FROM files WHERE session_id = ${sqlString(sessionId)}`,
  );
  const paths = rows.map((r) => String(r.path));
  if (paths.length === 0) return { mainEvents: [], subagents: [] };

  return connectorForSession(sessionId).loadSession(sessionId, paths);
}
