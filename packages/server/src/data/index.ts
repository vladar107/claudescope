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

/** The four rate fields, in canonical → SQL-column order. */
const RATE_FIELDS = [
  ['input', 'input', 'input_tokens'],
  ['output', 'output', 'output_tokens'],
  ['cacheWrite', 'cache_write', 'cache_write_tokens'],
  ['cacheRead', 'cache_read', 'cache_read_tokens'],
] as const satisfies readonly (readonly [keyof PricingConfig['models'][string], string, string])[];

/** Alias the per-file projection gets when joined against {@link pricing_rates}. */
const EVENTS_ALIAS = 'ev';

/** Alias the {@link pricing_rates} join table gets in the cost expression. */
const RATES_ALIAS = 'pr';

/**
 * (Re)create and populate the `pricing_rates` join table from the merged
 * pricing's exact-id model rates. At a few hundred rows this is cheap, so we
 * just recreate it once per reindex run (never per file). The cost expression
 * (see {@link buildCostExpr}) LEFT JOINs each event's `model` against this table
 * for the exact-id rate, falling back to family/default in SQL.
 */
async function syncPricingTable(conn: DuckDBConnection, pricing: PricingConfig): Promise<void> {
  await conn.run('DROP TABLE IF EXISTS pricing_rates');
  await conn.run(`
    CREATE TABLE pricing_rates (
      model       VARCHAR PRIMARY KEY,
      input       DOUBLE,
      output      DOUBLE,
      cache_write DOUBLE,
      cache_read  DOUBLE
    )
  `);

  const rows = Object.entries(pricing.models);
  if (rows.length === 0) return;
  const values = rows
    .map(
      ([model, r]) =>
        `(${sqlString(model)}, ${r.input}, ${r.output}, ${r.cacheWrite}, ${r.cacheRead})`,
    )
    .join(', ');
  await conn.run(`INSERT INTO pricing_rates VALUES ${values}`);
}

/**
 * Build the per-event cost expression (USD). Costs are computed in SQL so the
 * value is persisted on each event row and analytics can simply SUM it. Rates
 * are USD per 1M tokens.
 *
 * Per rate field the value is `COALESCE(exact-id join rate, family substring
 * match, default literal)`: the exact id comes from the {@link pricing_rates}
 * join table (aliased {@link RATES_ALIAS}), the family match is a small CASE
 * over `pricing.families` (a handful of branches), and the default is a literal.
 * Operates on the canonical token columns, so it is agent-agnostic.
 *
 * The caller must LEFT JOIN the projection against `pricing_rates ${RATES_ALIAS}`
 * on the model column (see {@link loadFile}).
 */
function buildCostExpr(pricing: PricingConfig): string {
  const rateExpr = (field: keyof PricingConfig['models'][string], column: string): string => {
    const cases: string[] = [];
    // Family substring matches (opus/sonnet/haiku/…), so any version or
    // date-suffixed id still resolves when no exact-id row joined.
    for (const [family, rates] of Object.entries(pricing.families ?? {})) {
      const pat = sqlString(`%${family.toLowerCase()}%`);
      cases.push(`WHEN lower(${EVENTS_ALIAS}.model) LIKE ${pat} THEN ${rates[field]}`);
    }
    const familyExpr =
      cases.length > 0 ? `CASE ${cases.join(' ')} ELSE ${pricing.default[field]} END` : `${pricing.default[field]}`;
    // Exact-id rate (join) wins; then family; then default.
    return `COALESCE(${RATES_ALIAS}.${column}, ${familyExpr})`;
  };

  // Cost is only attributable to assistant events (the ones carrying usage).
  const terms = RATE_FIELDS.map(
    ([field, column, tokenCol]) => `COALESCE(${EVENTS_ALIAS}.${tokenCol}, 0) * ${rateExpr(field, column)}`,
  );
  return `
    (
      ${terms.join(' +\n      ')}
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
  // Formats that can't be projected per-row normalize to a canonical NDJSON first.
  await connector.prepare?.(file.path);
  // Delete stale aux rows before clearing events: if an ai-title or pr-link line
  // was removed from the transcript, the old row must not survive the reload and
  // get LEFT JOINed back into the rebuilt session. The subquery reads events
  // before they are deleted, so these must come first.
  await conn.run(`DELETE FROM titles   WHERE session_id IN (SELECT DISTINCT session_id FROM events WHERE file_path = ${path})`);
  await conn.run(`DELETE FROM pr_links WHERE session_id IN (SELECT DISTINCT session_id FROM events WHERE file_path = ${path})`);
  await conn.run(`DELETE FROM events WHERE file_path = ${path}`);

  // The cost expression references the projected token/model columns plus the
  // pricing_rates join (aliased `pr` — see buildCostExpr). LEFT JOIN on the
  // model column so events whose model has no exact-id row fall through to the
  // family/default CASE; the table is recreated each reindex (syncPricingTable).
  await conn.run(`
    INSERT INTO events
    SELECT
      ev.file_path, ev.session_id, ev.uuid, ev.parent_uuid, ev.role, ev.type, ev.ts, ev.cwd, ev.git_branch,
      ev.model, ev.input_tokens, ev.output_tokens, ev.cache_read_tokens, ev.cache_write_tokens,
      ev.service_tier, ev.is_sidechain, ev.tool_use_count,
      ${costExpr} AS cost_usd,
      ev.text_content,
      ev.message_id, ev.forked_from_session_id, TRUE AS usage_canonical
    FROM (
      ${connector.eventsProjectionSql(file.path)}
    ) AS ev
    LEFT JOIN pricing_rates ${RATES_ALIAS} ON ${RATES_ALIAS}.model = ev.model
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
 * Mark exactly one `events` row per billed API call as the usage-canonical one,
 * so token/cost SUMs don't multiply-count a single API response.
 *
 * Why this is needed: Claude Code writes one row per content block, all sharing
 * the same `message.id` and repeating the FULL `usage` object; and forking a
 * session copies the whole history into a new file (sessionId rewritten, usage
 * preserved), with each copied row carrying a top-level `forkedFrom` marker.
 * Both inflate the per-event usage SUMs. Codex/Junie carry NULL message_id and
 * accumulate per-call deltas once in their normalizers, so they are unaffected.
 *
 * The election runs globally each reindex (a full recompute over `events`, cheap
 * at this scale) so it stays correct across files added, edited, or removed:
 *  - Rows with NULL message_id are ALWAYS canonical (synthetic rows have unique
 *    ids when present, so partitioning by message_id never collapses real calls).
 *  - Within a `message_id` partition, prefer the original over fork copies
 *    (exact attribution), then the final streaming row over partial ones (only
 *    `output_tokens` grows across a streamed group), then a deterministic
 *    file_path/uuid tiebreak for legacy forks that predate the `forkedFrom`
 *    marker. If the original file was deleted, a fork copy wins rank 1 and the
 *    cost gracefully re-attaches to the surviving fork session.
 */
async function electCanonicalUsage(conn: DuckDBConnection): Promise<void> {
  // Reset: NULL-id rows are always canonical; everything else starts non-canonical
  // and only the elected rank-1 row per partition is flipped back below.
  await conn.run(`UPDATE events SET usage_canonical = (message_id IS NULL)`);
  await conn.run(`
    UPDATE events SET usage_canonical = TRUE
    FROM (
      SELECT file_path, uuid, message_id,
             row_number() OVER (
               PARTITION BY message_id
               ORDER BY (forked_from_session_id IS NOT NULL) ASC,
                        output_tokens DESC,
                        file_path, uuid
             ) AS rn
      FROM events
      WHERE message_id IS NOT NULL
    ) w
    WHERE events.file_path = w.file_path
      AND events.uuid = w.uuid
      AND events.message_id = w.message_id
      AND w.rn = 1
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
    session_connector AS (
      SELECT session_id, any_value(connector_id) AS connector_id
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
        -- Usage/cost SUMs filter on usage_canonical so a single billed API call
        -- (written as many content-block rows, or copied by a fork) is counted
        -- once; COALESCE guards a session whose every usage row is non-canonical.
        COALESCE(sum(input_tokens) FILTER (WHERE usage_canonical), 0) AS input_tokens,
        COALESCE(sum(output_tokens) FILTER (WHERE usage_canonical), 0) AS output_tokens,
        COALESCE(sum(cache_read_tokens) FILTER (WHERE usage_canonical), 0) AS cache_read_tokens,
        COALESCE(sum(cache_write_tokens) FILTER (WHERE usage_canonical), 0) AS cache_write_tokens,
        COALESCE(sum(cost_usd) FILTER (WHERE usage_canonical), 0) AS total_cost_usd,
        bool_or(is_sidechain) AS has_sidechain,
        list_distinct(list(model) FILTER (WHERE model IS NOT NULL)) AS model_list
      FROM events GROUP BY session_id
    ),
    first_user AS (
      -- Title fallback: the first user turn's text, whitespace-collapsed and
      -- clipped. Used when there's no explicit ai-title (e.g. all Codex
      -- sessions, and Claude sessions that were never auto-titled).
      SELECT session_id, snippet FROM (
        SELECT
          session_id,
          trim(left(regexp_replace(text_content, '\\s+', ' ', 'g'), 80)) AS snippet,
          row_number() OVER (PARTITION BY session_id ORDER BY ts ASC NULLS LAST) AS rn
        FROM events
        WHERE role = 'user' AND text_content IS NOT NULL AND length(trim(text_content)) > 0
      ) WHERE rn = 1
    )
    SELECT
      a.session_id AS id,
      mc.cwd AS project_cwd,
      COALESCE(NULLIF(t.title, ''), NULLIF(fu.snippet, ''), '') AS title,
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
      a.has_sidechain,
      sc.connector_id
    FROM agg a
    LEFT JOIN modal_cwd mc ON mc.session_id = a.session_id
    LEFT JOIN titles t ON t.session_id = a.session_id
    LEFT JOIN first_user fu ON fu.session_id = a.session_id
    LEFT JOIN pr_links p ON p.session_id = a.session_id
    LEFT JOIN file_size fs ON fs.session_id = a.session_id
    LEFT JOIN session_connector sc ON sc.session_id = a.session_id
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
  // Refresh the pricing join table (cheap; recreated once per run) before any
  // file loads so the cost expression's exact-id join sees current rates.
  await syncPricingTable(conn, pricing);
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
      // Delete stale aux rows before clearing events: the subquery reads events
      // to resolve session ids, so aux deletes must precede the events delete.
      await conn.run(`DELETE FROM titles   WHERE session_id IN (SELECT DISTINCT session_id FROM events WHERE file_path = ${sqlString(path)})`);
      await conn.run(`DELETE FROM pr_links WHERE session_id IN (SELECT DISTINCT session_id FROM events WHERE file_path = ${sqlString(path)})`);
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

    // Isolate per-file failures: a file DuckDB can't read at all (beyond the
    // per-line `ignore_errors` tolerance) must not abort the whole reindex and
    // wedge every other session. Skip it (its `files` row keeps the old mtime,
    // so a later edit retries it) and carry on.
    try {
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
        INSERT OR REPLACE INTO files (path, mtime_ms, size_bytes, session_id, project_cwd, connector_id, indexed_at)
        VALUES (${sqlString(file.path)}, ${file.mtimeMs}, ${file.size},
                ${sessionId ? sqlString(sessionId) : 'NULL'},
                ${cwd ? sqlString(cwd) : 'NULL'}, ${sqlString(connector.id)}, now())
      `);
      reindexed += 1;
    } catch (err) {
      console.warn(`claudescope: skipping unreadable transcript ${file.path}:`, err);
    }
  }

  // Nothing changed on disk: skip the (relatively expensive) derived-table and
  // FTS rebuild + CHECKPOINT entirely. This keeps periodic auto-reindex polls
  // cheap — they only stat files and bail when there's no new data.
  if (reindexed === 0 && removed === 0) {
    ready = true;
    return { reindexed, durationMs: Date.now() - start };
  }

  // Something changed: re-elect the usage-canonical rows globally, then rebuild
  // derived tables + FTS so additions, edits, and removals are all reflected.
  await electCanonicalUsage(conn);
  await rebuildSessions(conn);
  await rebuildFtsIndex(conn);

  ready = true;
  return { reindexed, durationMs: Date.now() - start };
}
