/**
 * The `AgentConnector` port — the seam that lets Claudescope ingest transcripts
 * from different coding agents (Claude Code, Codex, …) without the indexer
 * knowing any agent's wire format.
 *
 * Design: connectors normalize by **SQL projection**, not by streaming TS
 * objects. For a JSONL-native agent, the connector hands back a `SELECT` that
 * reads its raw file (its own `read_ndjson` column map) and projects rows into
 * the canonical `events` column contract below. The indexer wraps that with the
 * central cost expression and the shared derived-table / FTS rebuild. DuckDB
 * keeps doing the heavy lifting natively, so adding an agent does not move the
 * hot path into the TS layer.
 */

import type { SessionData } from '../data/session-loader.js';

/** A discovered source file with the stats used for incremental change detection. */
export interface DiscoveredFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Canonical inner-column contract that `eventsProjectionSql` must emit, in any
 * order (the indexer selects them by name). Cost is NOT included — it is derived
 * centrally from the token columns × pricing.
 */
export const CANONICAL_EVENT_COLUMNS = [
  'file_path',
  'session_id',
  'uuid',
  'parent_uuid',
  'role',
  'type',
  'ts',
  'cwd',
  'git_branch',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'service_tier',
  'is_sidechain',
  'tool_use_count',
  'text_content',
] as const;

/**
 * Optional auxiliary, session-keyed projections. Each value is a `SELECT` body
 * the indexer wraps with `INSERT OR REPLACE INTO <table> (...)`:
 *   - `titles` → `(session_id, title)`
 *   - `prLinks` → `(session_id, pr_number, pr_repository, pr_url)`
 * Agents without these (e.g. Codex) simply omit them.
 */
export interface AuxProjections {
  titles?: string;
  prLinks?: string;
}

/** A source of agent transcripts. One implementation per supported agent. */
export interface AgentConnector {
  /** Stable id, e.g. `'claude-code'`. */
  id: string;

  /** Locate every transcript file this agent owns, with mtime/size for change detection. */
  discover(): DiscoveredFile[];

  /**
   * A `SELECT` projecting the raw file at `filePath` into the canonical event
   * columns (see {@link CANONICAL_EVENT_COLUMNS}). Executed in DuckDB.
   */
  eventsProjectionSql(filePath: string): string;

  /** Optional session-keyed aux projections (titles, PR links). */
  auxProjections(filePath: string): AuxProjections;

  /**
   * Read a single session's files (already resolved from the `files` table) and
   * normalize them into the domain `SessionData` consumed by the thread
   * assembler. `paths` are all files recorded for the session.
   */
  loadSession(sessionId: string, paths: string[]): Promise<SessionData>;
}
