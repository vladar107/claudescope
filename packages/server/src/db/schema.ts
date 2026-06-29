/**
 * DuckDB schema for the index store.
 *
 * The index keeps each session's `message` as JSON only transiently (during
 * load); persisted tables are FULLY FLATTENED so the API layer never has to
 * re-parse JSON at query time. An `fts` index over {@link events}.textContent
 * is rebuilt after every load.
 *
 * Tables:
 *  - files:    one row per indexed `*.jsonl` file. Tracks mtime+size so the
 *              indexer can skip unchanged files (incremental reindex).
 *  - events:   one row per conversational (user/assistant) event, with usage,
 *              per-event cost, and extracted plain text for full-text search.
 *  - sessions: derived per-session metadata (counts, totals, time span, etc).
 *  - projects: derived per-cwd metadata.
 *  - pr_links: pr-link events keyed by sessionId.
 *  - titles:   ai-title events keyed by sessionId (latest wins).
 */

// Bump when a persisted table shape changes — OR when derivation logic changes
// the persisted derived values (e.g. how a title or the FTS text is computed),
// so existing indexes pick up the new output. On a version mismatch the index
// (a derived cache) is discarded and rebuilt from source — see db/duckdb.ts.
// v5: Codex title fallback (first user message) + `<image …>` placeholder strip.
// v6: usage dedup by billed API call (message_id / forked_from_session_id / usage_canonical).
// v7: fallback title cleaning (strip markup/wrapper blobs) + `title_derived` flag.
// v8: per-event tool_names (comma-joined canonical tool names) for the tool-usage breakdown.
export const SCHEMA_VERSION = 8;

/** All DDL statements, executed in order at startup. Idempotent. */
export const SCHEMA_DDL: readonly string[] = [
  // Key/value table holding the schema signature this DB was built with, so a
  // version OR shape change forces a rebuild (see db/duckdb.ts).
  `CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR)`,

  `CREATE TABLE IF NOT EXISTS files (
     path         VARCHAR PRIMARY KEY,
     mtime_ms     BIGINT  NOT NULL,
     size_bytes   BIGINT  NOT NULL,
     session_id   VARCHAR,
     project_cwd  VARCHAR,
     connector_id VARCHAR,
     indexed_at   TIMESTAMP DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS events (
     file_path    VARCHAR NOT NULL,
     session_id   VARCHAR NOT NULL,
     uuid         VARCHAR,
     parent_uuid  VARCHAR,
     role         VARCHAR,
     type         VARCHAR NOT NULL,
     ts           TIMESTAMP,
     cwd          VARCHAR,
     git_branch   VARCHAR,
     model        VARCHAR,
     input_tokens        BIGINT DEFAULT 0,
     output_tokens       BIGINT DEFAULT 0,
     cache_read_tokens   BIGINT DEFAULT 0,
     cache_write_tokens  BIGINT DEFAULT 0,
     service_tier VARCHAR,
     is_sidechain BOOLEAN DEFAULT FALSE,
     tool_use_count INTEGER DEFAULT 0,
     tool_names   VARCHAR DEFAULT '',
     cost_usd     DOUBLE DEFAULT 0,
     text_content VARCHAR,
     message_id   VARCHAR,
     forked_from_session_id VARCHAR,
     usage_canonical BOOLEAN DEFAULT TRUE
   )`,

  `CREATE TABLE IF NOT EXISTS sessions (
     id            VARCHAR PRIMARY KEY,
     project_cwd   VARCHAR,
     title         VARCHAR,
     -- TRUE when title was derived from the first user message (cleaned) rather
     -- than a real stored title -- lets the UI mark it "from first message".
     title_derived BOOLEAN DEFAULT FALSE,
     started_at    TIMESTAMP,
     ended_at      TIMESTAMP,
     message_count BIGINT DEFAULT 0,
     tool_call_count BIGINT DEFAULT 0,
     total_tokens  BIGINT DEFAULT 0,
     total_cost_usd DOUBLE DEFAULT 0,
     input_tokens  BIGINT DEFAULT 0,
     output_tokens BIGINT DEFAULT 0,
     cache_read_tokens  BIGINT DEFAULT 0,
     cache_write_tokens BIGINT DEFAULT 0,
     models        VARCHAR,
     git_branch    VARCHAR,
     pr_url        VARCHAR,
     size_bytes    BIGINT DEFAULT 0,
     has_sidechain BOOLEAN DEFAULT FALSE,
     connector_id  VARCHAR
   )`,

  `CREATE TABLE IF NOT EXISTS pr_links (
     session_id  VARCHAR PRIMARY KEY,
     pr_number   BIGINT,
     pr_repository VARCHAR,
     pr_url      VARCHAR
   )`,

  `CREATE TABLE IF NOT EXISTS titles (
     session_id VARCHAR PRIMARY KEY,
     title      VARCHAR
   )`,

  `CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_cwd ON events (cwd)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts)`,
];
