/**
 * Incremental indexer.
 *
 * Scans {@link CLAUDE_PROJECTS_DIR} for `*.jsonl` session files (including the
 * sidechain/subagent subdirectories that may sit beside a session file), and
 * upserts flattened events into DuckDB via `read_ndjson(...)`. Files whose
 * (mtime, size) are unchanged versus the `files` table are skipped, so a
 * reindex only touches what changed.
 *
 * After loading, derived `sessions` / `projects`-input rows are recomputed and
 * the FTS index over `events.text_content` is rebuilt (cheap at this scale).
 *
 * STRICTLY READ-ONLY with respect to ~/.claude — files are only ever read.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { PricingConfig, ReindexResponse } from '@claudescope/shared';
import { CLAUDE_PROJECTS_DIR } from '../config.js';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { loadPricing } from './pricing.js';

/** Tracks whether the initial index build has finished (server readiness). */
let ready = false;
/** Serializes concurrent reindex calls so they never run simultaneously. */
let inFlight: Promise<ReindexResponse> | null = null;

export function isIndexReady(): boolean {
  return ready;
}

interface DiscoveredFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Recursively collect every `*.jsonl` file under the projects directory. The
 * top level holds `<encoded-cwd>/<session>.jsonl`; sidechain events live in a
 * `<session-uuid>/` subdirectory beside the file, so we recurse one level.
 */
function discoverFiles(): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];

  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = statSync(full);
          out.push({ path: full, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
        } catch {
          /* file vanished between readdir and stat; ignore */
        }
      }
    }
  };

  walk(CLAUDE_PROJECTS_DIR);
  return out;
}

/**
 * Build the SQL expression that extracts FTS-searchable plain text from a
 * `message` JSON value. `message.content` is either a plain string or an array
 * of blocks; for arrays we concatenate the `text`/`thinking` block bodies.
 */
const TEXT_CONTENT_EXPR = `
  CASE
    WHEN message IS NULL THEN NULL
    WHEN json_type(message -> '$.content') = 'VARCHAR'
      THEN json_extract_string(message, '$.content')
    ELSE (
      SELECT string_agg(
        coalesce(
          json_extract_string(b.value, '$.text'),
          json_extract_string(b.value, '$.thinking')
        ),
        ' '
      )
      FROM json_each(message, '$.content') AS b
      WHERE json_extract_string(b.value, '$.type') IN ('text', 'thinking')
    )
  END`;

/** Count of `tool_use` blocks inside a message's content array (0 for strings). */
const TOOL_USE_COUNT_EXPR = `
  CASE
    WHEN message IS NULL OR json_type(message -> '$.content') = 'VARCHAR' THEN 0
    ELSE (
      SELECT count(*)
      FROM json_each(message, '$.content') AS b
      WHERE json_extract_string(b.value, '$.type') = 'tool_use'
    )
  END`;

/**
 * Build the per-event cost expression (USD) from the pricing config. Costs are
 * computed in SQL via a big CASE over the model id so the value is persisted on
 * each event row and analytics can simply SUM it. Rates are USD per 1M tokens.
 */
function buildCostExpr(pricing: PricingConfig): string {
  const rateExpr = (field: keyof PricingConfig['models'][string]): string => {
    const cases: string[] = [];
    for (const [model, rates] of Object.entries(pricing.models)) {
      cases.push(`WHEN model = ${sqlString(model)} THEN ${rates[field]}`);
    }
    cases.push(`ELSE ${pricing.default[field]}`);
    return `CASE ${cases.join(' ')} END`;
  };

  // Cost is only attributable to assistant events (the ones carrying usage).
  return `
    (
      COALESCE(input_tokens, 0)       * ${rateExpr('input')}      +
      COALESCE(output_tokens, 0)      * ${rateExpr('output')}     +
      COALESCE(cache_write_tokens, 0) * ${rateExpr('cacheWrite')} +
      COALESCE(cache_read_tokens, 0)  * ${rateExpr('cacheRead')}
    ) / 1000000.0`;
}

/**
 * Load (or reload) a single file's conversational events into the `events`
 * table. Existing rows for the file are deleted first so re-indexing a changed
 * file is a clean replace.
 */
async function loadFileEvents(
  conn: DuckDBConnection,
  file: DiscoveredFile,
  costExpr: string,
): Promise<void> {
  const path = sqlString(file.path);
  const readFn = `read_ndjson(${path}, union_by_name=true, format='newline_delimited', maximum_object_size=268435456, columns={
    type:'VARCHAR', uuid:'VARCHAR', parentUuid:'VARCHAR', sessionId:'VARCHAR',
    timestamp:'VARCHAR', cwd:'VARCHAR', gitBranch:'VARCHAR', isSidechain:'BOOLEAN',
    message:'JSON'
  })`;

  await conn.run(`DELETE FROM events WHERE file_path = ${path}`);

  // First materialize the flattened token columns, then derive cost from them.
  await conn.run(`
    INSERT INTO events
    SELECT
      file_path, session_id, uuid, parent_uuid, role, type, ts, cwd, git_branch,
      model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      service_tier, is_sidechain, tool_use_count,
      ${costExpr} AS cost_usd,
      text_content
    FROM (
      SELECT
        ${path} AS file_path,
        sessionId AS session_id,
        uuid,
        parentUuid AS parent_uuid,
        json_extract_string(message, '$.role') AS role,
        type,
        try_cast(timestamp AS TIMESTAMP) AS ts,
        cwd,
        gitBranch AS git_branch,
        json_extract_string(message, '$.model') AS model,
        COALESCE(try_cast(json_extract(message, '$.usage.input_tokens') AS BIGINT), 0) AS input_tokens,
        COALESCE(try_cast(json_extract(message, '$.usage.output_tokens') AS BIGINT), 0) AS output_tokens,
        COALESCE(try_cast(json_extract(message, '$.usage.cache_read_input_tokens') AS BIGINT), 0) AS cache_read_tokens,
        COALESCE(try_cast(json_extract(message, '$.usage.cache_creation_input_tokens') AS BIGINT), 0) AS cache_write_tokens,
        json_extract_string(message, '$.usage.service_tier') AS service_tier,
        COALESCE(isSidechain, FALSE) AS is_sidechain,
        ${TOOL_USE_COUNT_EXPR} AS tool_use_count,
        ${TEXT_CONTENT_EXPR} AS text_content
      FROM ${readFn}
      WHERE type IN ('user', 'assistant')
    )
  `);
}

/**
 * Load auxiliary sessionId-keyed events (ai-title, pr-link) for a file. These
 * are not conversational events; they are upserted into their own small tables.
 */
async function loadAuxEvents(conn: DuckDBConnection, file: DiscoveredFile): Promise<void> {
  const path = sqlString(file.path);
  const readFn = `read_ndjson(${path}, union_by_name=true, format='newline_delimited', maximum_object_size=268435456, columns={
    type:'VARCHAR', sessionId:'VARCHAR', aiTitle:'VARCHAR',
    prNumber:'BIGINT', prRepository:'VARCHAR', prUrl:'VARCHAR'
  })`;

  // ai-title: latest non-null title in the file wins.
  await conn.run(`
    INSERT OR REPLACE INTO titles (session_id, title)
    SELECT sessionId, last(aiTitle) AS title
    FROM ${readFn}
    WHERE type = 'ai-title' AND sessionId IS NOT NULL AND aiTitle IS NOT NULL
    GROUP BY sessionId
  `);

  // pr-link: latest pr per session.
  await conn.run(`
    INSERT OR REPLACE INTO pr_links (session_id, pr_number, pr_repository, pr_url)
    SELECT sessionId, last(prNumber), last(prRepository), last(prUrl)
    FROM ${readFn}
    WHERE type = 'pr-link' AND sessionId IS NOT NULL AND prUrl IS NOT NULL
    GROUP BY sessionId
  `);
}

/**
 * Recompute the derived `sessions` table from `events`, `titles`, and
 * `pr_links`. Cheap full recompute (no per-file partial maintenance needed at
 * this scale). `project_cwd` is the modal (most frequent) cwd of the session's
 * events — robust to subdirectory cwds appearing mid-session.
 */
async function rebuildSessions(conn: DuckDBConnection): Promise<void> {
  await conn.run('DELETE FROM sessions');
  await conn.run(`
    INSERT INTO sessions
    WITH file_size AS (
      SELECT session_id, sum(size_bytes) AS size_bytes
      FROM files WHERE session_id IS NOT NULL GROUP BY session_id
    ),
    modal_cwd AS (
      SELECT session_id, cwd FROM (
        SELECT session_id, cwd,
               row_number() OVER (PARTITION BY session_id ORDER BY count(*) DESC) AS rn
        FROM events WHERE cwd IS NOT NULL GROUP BY session_id, cwd
      ) WHERE rn = 1
    ),
    agg AS (
      SELECT
        session_id,
        min(ts) AS started_at,
        max(ts) AS ended_at,
        count(*) AS message_count,
        sum(tool_use_count) AS tool_call_count,
        sum(input_tokens) AS input_tokens,
        sum(output_tokens) AS output_tokens,
        sum(cache_read_tokens) AS cache_read_tokens,
        sum(cache_write_tokens) AS cache_write_tokens,
        sum(cost_usd) AS total_cost_usd,
        bool_or(is_sidechain) AS has_sidechain,
        list_distinct(list(model) FILTER (WHERE model IS NOT NULL)) AS model_list
      FROM events GROUP BY session_id
    )
    SELECT
      a.session_id AS id,
      mc.cwd AS project_cwd,
      COALESCE(t.title, '') AS title,
      a.started_at,
      a.ended_at,
      a.message_count,
      a.tool_call_count,
      a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_write_tokens AS total_tokens,
      a.total_cost_usd,
      a.input_tokens,
      a.output_tokens,
      a.cache_read_tokens,
      a.cache_write_tokens,
      array_to_string(a.model_list, ',') AS models,
      NULL AS git_branch,
      p.pr_url,
      COALESCE(fs.size_bytes, 0) AS size_bytes,
      a.has_sidechain
    FROM agg a
    LEFT JOIN modal_cwd mc ON mc.session_id = a.session_id
    LEFT JOIN titles t ON t.session_id = a.session_id
    LEFT JOIN pr_links p ON p.session_id = a.session_id
    LEFT JOIN file_size fs ON fs.session_id = a.session_id
  `);

  // git_branch: most recent non-null branch seen for the session.
  await conn.run(`
    UPDATE sessions s SET git_branch = (
      SELECT git_branch FROM events e
      WHERE e.session_id = s.id AND e.git_branch IS NOT NULL
      ORDER BY ts DESC NULLS LAST LIMIT 1
    )
  `);
}

/** (Re)build the BM25 full-text index over event text. */
async function rebuildFtsIndex(conn: DuckDBConnection): Promise<void> {
  // create_fts_index requires overwrite=1 to replace an existing index.
  await conn.run(`
    PRAGMA create_fts_index('events', 'uuid', 'text_content', overwrite=1)
  `);
  // Force a CHECKPOINT so the FTS index DDL is merged into the main DB file
  // instead of lingering in the WAL. DuckDB cannot replay the FTS schema's
  // DROP/CREATE from a WAL on the next open (the `fts_main_events`.`terms`
  // dependency fails), so an unflushed WAL would corrupt the file if the
  // process is killed. Checkpointing keeps reopen clean.
  await conn.run('CHECKPOINT');
}

/**
 * Run an incremental index pass. Only files whose (mtime, size) differ from the
 * recorded `files` row are (re)loaded. Returns the number of files (re)indexed
 * and the elapsed wall-clock time.
 */
export async function reindex(): Promise<ReindexResponse> {
  if (inFlight) return inFlight;
  inFlight = doReindex();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function doReindex(): Promise<ReindexResponse> {
  const start = Date.now();
  const conn = await getConnection();
  const pricing = loadPricing();
  const costExpr = buildCostExpr(pricing);

  const discovered = discoverFiles();

  // Build a lookup of already-indexed (path -> mtime,size).
  const existingRows = await queryRows(conn, 'SELECT path, mtime_ms, size_bytes FROM files');
  const existing = new Map<string, { mtime: number; size: number }>();
  for (const r of existingRows) {
    existing.set(String(r.path), { mtime: Number(r.mtime_ms), size: Number(r.size_bytes) });
  }

  const discoveredPaths = new Set(discovered.map((f) => f.path));

  // Drop files that no longer exist on disk (and their events).
  let removed = 0;
  for (const path of existing.keys()) {
    if (!discoveredPaths.has(path)) {
      await conn.run(`DELETE FROM events WHERE file_path = ${sqlString(path)}`);
      await conn.run(`DELETE FROM files WHERE path = ${sqlString(path)}`);
      removed += 1;
    }
  }

  let reindexed = 0;
  for (const file of discovered) {
    const prev = existing.get(file.path);
    if (prev && prev.mtime === file.mtimeMs && prev.size === file.size) {
      continue; // unchanged
    }

    await loadFileEvents(conn, file, costExpr);
    await loadAuxEvents(conn, file);

    // Determine the session id from loaded events (filename usually matches,
    // but the event sessionId is authoritative).
    const sidRows = await queryRows(
      conn,
      `SELECT session_id FROM events WHERE file_path = ${sqlString(file.path)} LIMIT 1`,
    );
    const sessionId = sidRows.length > 0 ? String(sidRows[0]?.session_id ?? '') : null;
    const cwdRows = await queryRows(
      conn,
      `SELECT cwd FROM events WHERE file_path = ${sqlString(file.path)} AND cwd IS NOT NULL LIMIT 1`,
    );
    const cwd = cwdRows.length > 0 ? String(cwdRows[0]?.cwd ?? '') : null;

    await conn.run(`
      INSERT OR REPLACE INTO files (path, mtime_ms, size_bytes, session_id, project_cwd, indexed_at)
      VALUES (${sqlString(file.path)}, ${file.mtimeMs}, ${file.size},
              ${sessionId ? sqlString(sessionId) : 'NULL'},
              ${cwd ? sqlString(cwd) : 'NULL'}, now())
    `);
    reindexed += 1;
  }

  // Nothing changed on disk: skip the (relatively expensive) derived-table and
  // FTS rebuild + CHECKPOINT entirely. This keeps periodic auto-reindex polls
  // cheap — they only stat files and bail when there's no new data.
  if (reindexed === 0 && removed === 0) {
    ready = true;
    return { reindexed, durationMs: Date.now() - start };
  }

  // Something changed: rebuild derived tables + FTS so additions, edits, and
  // removals are all reflected.
  await rebuildSessions(conn);
  await rebuildFtsIndex(conn);

  ready = true;
  return { reindexed, durationMs: Date.now() - start };
}
