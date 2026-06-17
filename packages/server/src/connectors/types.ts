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

import type { MemorySource } from '@claudescope/shared';
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

  /** Human-friendly agent name, e.g. `'Claude Code'`. */
  label: string;

  /** Read-only source directory this connector reads from. */
  sourceDir: string;

  /** Locate every transcript file this agent owns, with mtime/size for change detection. */
  discover(): DiscoveredFile[];

  /**
   * Optional pre-pass run before {@link eventsProjectionSql}, for formats that
   * can't be projected per-row by DuckDB. The connector normalizes the raw file
   * in TS (e.g. correlating data spread across record types) and writes a
   * canonical NDJSON the projection then reads. Flat formats (Claude) omit this.
   */
  prepare?(filePath: string): Promise<void>;

  /**
   * A `SELECT` projecting the (possibly {@link prepare}d) file into the canonical
   * event columns (see {@link CANONICAL_EVENT_COLUMNS}). Executed in DuckDB.
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

  /**
   * Optional: the agent's global, cross-project memory — user-authored
   * instruction file(s) and/or agent-distilled global memory. Read live (NOT
   * indexed). Returns `[]` when the agent has none.
   *
   * INVARIANT: read only from the agent's own home dir (e.g. `~/.claude`,
   * `~/.codex`, `~/.junie`) — never from the user's project directories.
   */
  globalMemory?(): MemorySource[];

  /**
   * Optional: every agent-authored per-project memory directory this connector
   * owns, each tagged with the encoded-cwd `slug` that names it. Read live (NOT
   * indexed); returns `[]` when there are none.
   *
   * The connector does NOT attribute facts to Claudescope projects — it just
   * enumerates its memory dirs. The route attributes each fact to a project via
   * its `originSessionId` (falling back to the dir `slug` for facts whose origin
   * session is unknown), because a single memory dir is keyed by the git repo
   * root and so may hold facts learned across several worktrees/cwds.
   *
   * INVARIANT: read only from the agent's own home dir — never from the user's
   * project directories. (This is why Junie's repo-local `.junie/memory/` is out
   * of scope: surfacing it would require reading arbitrary project dirs.)
   */
  projectMemory?(): AgentMemoryDir[];

  /**
   * Optional: how to reopen this session in the agent's own CLI. Returns the
   * argv to exec (the server wraps it with `cd <cwd> && …`), or null when the
   * agent has no resume command. `sessionId` is the indexed session id, which
   * for every current connector is already the native id the CLI expects.
   */
  resumeSpec?(sessionId: string): ResumeSpec | null;
}

/**
 * The command(s) to reopen a session in an agent's CLI, as structured argv so
 * the copy-paste string and the macOS launcher script are both derived from the
 * same tokens (quoted once, in `connectors/resume.ts`).
 */
export interface ResumeSpec {
  /** argv that appends to the original session, e.g. `['claude','--resume',id]`. */
  resumeArgv: string[];
  /** argv that forks into a new session; omit when the agent has no CLI fork. */
  forkArgv?: string[];
}

/**
 * One agent-authored per-project memory directory: the facts it holds and the
 * encoded-cwd `slug` that names it (e.g. Claude's `~/.claude/projects/<slug>/`).
 * The slug is used by the route as the attribution fallback for facts whose
 * `originSessionId` can't be resolved to an indexed session.
 */
export interface AgentMemoryDir {
  slug: string;
  facts: MemorySource[];
}
