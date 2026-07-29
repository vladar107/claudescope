/**
 * The canonical event contract, in ONE place.
 *
 * Connectors whose source format can't be projected per-row normalize a session
 * to a canonical NDJSON first (`prepare()`), then hand the indexer a `SELECT`
 * that reads it back. That contract used to be restated three times per
 * connector — a `CanonicalRow` interface, a `read_ndjson` column map, and a
 * SELECT list — across seven connectors, with nothing checking that the 21
 * columns agreed. Adding `tool_error_count` in schema v10 therefore meant
 * touching ~16 hand-maintained lists, where a miss produces silently wrong data
 * rather than a type error.
 *
 * Now {@link CANONICAL_COLUMNS} is the single source: the row type, the column
 * map, and the SELECT list are all derived from it.
 *
 * NOTE: the Claude Code connector deliberately does NOT use this. It projects
 * its raw JSONL directly (its own column map plus a LATERAL block aggregate),
 * so it has no cache file and no canonical row — see `claude-code/claude-code.ts`.
 */

import { sqlString } from '../db/duckdb.js';

/**
 * Canonical column → its DuckDB type in the cache NDJSON. Order is the contract:
 * the generated SELECT emits these columns in exactly this order, and the
 * indexer's `INSERT INTO events` (see `data/index.ts:loadFile`) selects them by
 * name on top of that.
 */
export const CANONICAL_COLUMNS = {
  file_path: 'VARCHAR',
  session_id: 'VARCHAR',
  uuid: 'VARCHAR',
  parent_uuid: 'VARCHAR',
  role: 'VARCHAR',
  type: 'VARCHAR',
  ts: 'TIMESTAMP',
  cwd: 'VARCHAR',
  git_branch: 'VARCHAR',
  model: 'VARCHAR',
  provider: 'VARCHAR',
  input_tokens: 'BIGINT',
  output_tokens: 'BIGINT',
  cache_read_tokens: 'BIGINT',
  cache_write_tokens: 'BIGINT',
  service_tier: 'VARCHAR',
  is_sidechain: 'BOOLEAN',
  tool_use_count: 'INTEGER',
  tool_names: 'VARCHAR',
  tool_error_count: 'INTEGER',
  text_content: 'VARCHAR',
} as const;

/**
 * One row of a connector's canonical NDJSON — what `toCanonicalRows` returns.
 *
 * `provider` is optional because only pi/Codex/opencode record a serving
 * provider; `title` is optional and is NOT an events column at all — it rides
 * along in the same file for connectors that carry a real session title, read
 * back by {@link titlesProjectionSql}.
 */
export interface CanonicalRow {
  file_path: string;
  session_id: string;
  uuid: string;
  parent_uuid: string | null;
  role: string;
  type: string;
  ts: string;
  cwd: string;
  git_branch: string | null;
  model: string | null;
  /** Serving provider, when the source format records one (pi/Codex/opencode). */
  provider?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  service_tier: string | null;
  is_sidechain: boolean;
  tool_use_count: number;
  tool_names: string;
  /** NULL when the source format carries no error signal — distinct from 0. */
  tool_error_count: number | null;
  text_content: string;
  /** Session title; read by the aux projection, ignored by the events one. */
  title?: string;
}

/**
 * Shared `read_ndjson` options. `ignore_errors=true` skips a malformed line
 * instead of failing the whole file (and with it the reindex pass); the large
 * `maximum_object_size` covers transcripts with inlined base64 images.
 */
const READ_OPTS = "format='newline_delimited', maximum_object_size=268435456, ignore_errors=true";

/** `columns={...}` map for the given canonical columns. */
function columnsMap(names: readonly string[]): string {
  const entries = names.map((n) => `${n}:'${CANONICAL_COLUMNS[n as keyof typeof CANONICAL_COLUMNS]}'`);
  return `columns={${entries.join(', ')}}`;
}

/**
 * The events projection for a cache-backed connector: reads its canonical NDJSON
 * and emits the columns `loadFile` expects.
 *
 * `provider` is the only per-connector variation. When the connector doesn't
 * record one it is left out of the column map and selected as a NULL literal, so
 * the output shape is identical either way. `message_id` and
 * `forked_from_session_id` are always NULL — they exist for Claude Code's
 * usage-dedup election, and these formats accumulate usage once per call in
 * their normalizers instead.
 */
export function canonicalProjectionSql(cachePath: string, opts: { provider: boolean }): string {
  const names = Object.keys(CANONICAL_COLUMNS).filter(
    (n) => n !== 'provider' || opts.provider,
  );
  const selected = Object.keys(CANONICAL_COLUMNS).map((n) =>
    n === 'provider' && !opts.provider ? 'CAST(NULL AS VARCHAR) AS provider' : n,
  );
  return `
    SELECT
      ${selected.join(', ')},
      CAST(NULL AS VARCHAR) AS message_id, CAST(NULL AS VARCHAR) AS forked_from_session_id
    FROM read_ndjson(${sqlString(cachePath)}, ${READ_OPTS}, ${columnsMap(names)})`;
}

/**
 * The `titles` aux projection for a connector whose canonical rows carry a real
 * session title (Copilot's workspace name, Junie's taskName, opencode's and
 * Grok's stored titles). Latest non-empty title in the file wins; an empty
 * result simply leaves the first-user-message fallback in place.
 */
export function titlesProjectionSql(cachePath: string): string {
  return `
      SELECT session_id, last(title) AS title
      FROM read_ndjson(${sqlString(cachePath)}, ${READ_OPTS},
        columns={session_id:'VARCHAR', title:'VARCHAR'})
      WHERE session_id IS NOT NULL AND title IS NOT NULL AND title <> ''
      GROUP BY session_id`;
}
