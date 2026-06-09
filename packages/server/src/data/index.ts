/**
 * Incremental indexer.
 *
 * Asks each registered {@link AgentConnector} to discover its transcript files,
 * then upserts a canonical, format-agnostic `events` row shape into DuckDB via
 * each connector's projection SQL (executed natively by `read_ndjson`). Files
 * whose (mtime, size) are unchanged versus the `files` table are skipped, so a
 * reindex only touches what changed.
 *
 * After loading, derived `sessions` rows are recomputed and the FTS index over
 * `events.text_content` is rebuilt (cheap at this scale). Everything below the
 * connector boundary — the canonical schema, cost, derived tables, FTS — is
 * agent-agnostic.
 *
 * STRICTLY READ-ONLY with respect to the source transcripts — files are only read.
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import type { PricingConfig, ReindexResponse } from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { connectors } from '../connectors/registry.js';
import type { AgentConnector, DiscoveredFile } from '../connectors/types.js';
import { loadPricing } from './pricing.js';

/** Tracks whether the initial index build has finished (server readiness). */
let ready = false;
/** Serializes concurrent reindex calls so they never run simultaneously. */
let inFlight: Promise<ReindexResponse> | null = null;

export function isIndexReady(): boolean {
  return ready;
}

/**
 * Build the per-event cost expression (USD) from the pricing config. Costs are
 * computed in SQL via a big CASE over the model id so the value is persisted on
 * each event row and analytics can simply SUM it. Rates are USD per 1M tokens.
 * Operates on the canonical token columns, so it is agent-agnostic.
 */
function buildCostExpr(pricing: PricingConfig): string {
  const rateExpr = (field: keyof PricingConfig['models'][string]): string => {
    const cases: string[] = [];
    // Exact model ids win first.
    for (const [model, rates] of Object.entries(pricing.models)) {
      cases.push(`WHEN model = ${sqlString(model)} THEN ${rates[field]}`);
    }
    // Then family substring matches (opus/sonnet/haiku), so any version or
    // date-suffixed id still resolves.
    for (const [family, rates] of Object.entries(pricing.families ?? {})) {
      const pat = sqlString(`%${family.toLowerCase()}%`);
      cases.push(`WHEN lower(model) LIKE ${pat} THEN ${rates[field]}`);
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
 * Load (or reload) a single file's events into the `events` table via the
 * owning connector's projection. Existing rows for the file are deleted first so
 * re-indexing a changed file is a clean replace. The canonical column list and
 * the central cost expression are applied here; only the inner projection (and
 * the optional aux projections) are agent-specific.
 */
async function loadFile(
  conn: DuckDBConnection,
  connector: AgentConnector,
  file: DiscoveredFile,
  costExpr: string,
): Promise<void> {
  const path = sqlString(file.path);
  await conn.run(`DELETE FROM events WHERE file_path = ${path}`);

  await conn.run(`
    INSERT INTO events
    SELECT
      file_path, session_id, uuid, parent_uuid, role, type, ts, cwd, git_branch,
      model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      service_tier, is_sidechain, tool_use_count,
      ${costExpr} AS cost_usd,
      text_content
    FROM (
      ${connector.eventsProjectionSql(file.path)}
    )
  `);

  const aux = connector.auxProjections(file.path);
  if (aux.titles) {
    await conn.run(`INSERT OR REPLACE INTO titles (session_id, title) ${aux.titles}`);
  }
  if (aux.prLinks) {
    await conn.run(
      `INSERT OR REPLACE INTO pr_links (session_id, pr_number, pr_repository, pr_url) ${aux.prLinks}`,
    );
  }
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

  // Discover across every registered connector, tagging each file with its owner.
  const discovered: { file: DiscoveredFile; connector: AgentConnector }[] = [];
  for (const connector of connectors) {
    for (const file of connector.discover()) discovered.push({ file, connector });
  }

  // Build a lookup of already-indexed (path -> mtime,size).
  const existingRows = await queryRows(conn, 'SELECT path, mtime_ms, size_bytes FROM files');
  const existing = new Map<string, { mtime: number; size: number }>();
  for (const r of existingRows) {
    existing.set(String(r.path), { mtime: Number(r.mtime_ms), size: Number(r.size_bytes) });
  }

  const discoveredPaths = new Set(discovered.map((d) => d.file.path));

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
  for (const { file, connector } of discovered) {
    const prev = existing.get(file.path);
    if (prev && prev.mtime === file.mtimeMs && prev.size === file.size) {
      continue; // unchanged
    }

    await loadFile(conn, connector, file, costExpr);

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
