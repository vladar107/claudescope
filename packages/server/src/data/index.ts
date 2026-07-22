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
import type { IndexingProgress, PricingConfig, ReindexResponse } from '@claudescope/shared';
import { closeConnection, discardDbFiles, getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { connectors } from '../connectors/registry.js';
import type { AgentConnector, DiscoveredFile } from '../connectors/types.js';
import { loadPricing } from './pricing.js';
import { cleanFallbackTitle } from './title.js';
import { electCanonicalEdits, refreshFileEdits } from './file-edits.js';

/** Tracks whether the initial index build has finished (server readiness). */
let ready = false;
/** Serializes concurrent reindex calls so they never run simultaneously. */
let inFlight: Promise<ReindexResponse> | null = null;
/** Live progress of the current pass (changed files loaded vs. total). Non-null
 *  only while a pass with work is running; surfaced on /api/health. */
let progress: IndexingProgress | null = null;
/** Monotonic counter bumped whenever a pass changed the derived tables. An
 *  incremental pass is transient (sub-second), so idle clients can't observe
 *  `progress` — they watch this on /api/health instead and refetch when it
 *  moves. Resets on daemon restart, so clients compare by inequality. */
let dataVersion = 0;

/** Min interval between mid-first-build partial `sessions` rebuilds (ms).
 *  Env-overridable so tests can force a rebuild after every file. */
const PARTIAL_REBUILD_MS = Number(process.env.PARTIAL_REBUILD_MS ?? 3000);

export function isIndexReady(): boolean {
  return ready;
}

/** Whether a reindex pass is currently running (self-restart defers on it). */
export function isReindexInFlight(): boolean {
  return inFlight !== null;
}

/** True while an explicit discard-and-rebuild is running (see {@link rebuildIndex}). */
let rebuilding = false;
export function isRebuildInFlight(): boolean {
  return rebuilding;
}

/** Bookkeeping for the last completed pass (surfaced on the indexer status). */
let lastPass: ReindexResponse | null = null;
let lastPassAt: string | null = null;
export function getLastPass(): ReindexResponse | null {
  return lastPass;
}
export function getLastPassAt(): string | null {
  return lastPassAt;
}
function stampLastPass(res: ReindexResponse): ReindexResponse {
  lastPass = res;
  lastPassAt = new Date().toISOString();
  return res;
}

export function getIndexProgress(): IndexingProgress | null {
  return progress;
}

export function getDataVersion(): number {
  return dataVersion;
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
    const modelExpr = `COALESCE(${RATES_ALIAS}.${column}, ${familyExpr})`;
    // A listed provider OVERRIDES the whole model chain (this is how local
    // runtimes are zero-rated). `lower(NULL) = 'x'` is NULL in DuckDB, so
    // NULL/unlisted providers fall through to the model chain via ELSE.
    const providerCases: string[] = [];
    for (const [id, rates] of Object.entries(pricing.providers ?? {})) {
      const pat = sqlString(id.toLowerCase());
      providerCases.push(`WHEN lower(${EVENTS_ALIAS}.provider) = ${pat} THEN ${rates[field]}`);
    }
    return providerCases.length > 0
      ? `CASE ${providerCases.join(' ')} ELSE ${modelExpr} END`
      : modelExpr;
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
      ev.model, ev.provider, ev.input_tokens, ev.output_tokens, ev.cache_read_tokens, ev.cache_write_tokens,
      ev.service_tier, ev.is_sidechain, ev.tool_use_count, ev.tool_names,
      ${costExpr} AS cost_usd,
      ev.text_content,
      ev.message_id, ev.forked_from_session_id, TRUE AS usage_canonical,
      ev.tool_error_count
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
        list_distinct(list(model) FILTER (WHERE model IS NOT NULL)) AS model_list,
        list_distinct(list(provider) FILTER (WHERE provider IS NOT NULL)) AS provider_list
      FROM events GROUP BY session_id
    )
    SELECT
      a.session_id AS id,
      mc.cwd AS project_cwd,
      -- Real stored ai-title only; the cleaned first-message fallback (and the
      -- title_derived flag) is applied by applyFallbackTitles below.
      COALESCE(NULLIF(t.title, ''), '') AS title,
      FALSE AS title_derived,
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
      array_to_string(a.provider_list, ',') AS providers,
      NULL AS git_branch,
      p.pr_url,
      COALESCE(fs.size_bytes, 0) AS size_bytes,
      a.has_sidechain,
      sc.connector_id
    FROM agg a
    LEFT JOIN modal_cwd mc ON mc.session_id = a.session_id
    LEFT JOIN titles t ON t.session_id = a.session_id
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

  await applyFallbackTitles(conn);
}

/**
 * Fill in fallback titles for sessions with no real stored title, by cleaning
 * the first user message in TS (see {@link cleanFallbackTitle}). Runs after the
 * derived `sessions` rebuild, so it only touches rows whose `title` came back
 * empty. Cleaning happens in TS — not SQL — so markup/wrapper-blob stripping can
 * be tested as a pure function and stays deterministic across re-index.
 *
 * The raw first user turn per untitled session is fetched in one query (capped
 * to a few KB per row — cleaning only needs the head), then each cleaned title
 * is written back with `title_derived = TRUE`.
 */
async function applyFallbackTitles(conn: DuckDBConnection): Promise<void> {
  const rows = await queryRows(
    conn,
    `
    SELECT session_id, raw FROM (
      SELECT
        e.session_id,
        left(e.text_content, 4096) AS raw,
        row_number() OVER (PARTITION BY e.session_id ORDER BY e.ts ASC NULLS LAST) AS rn
      FROM events e
      JOIN sessions s ON s.id = e.session_id AND COALESCE(s.title, '') = ''
      WHERE e.role = 'user' AND e.text_content IS NOT NULL AND length(trim(e.text_content)) > 0
    ) WHERE rn = 1
    `,
  );

  const updates: string[] = [];
  for (const r of rows) {
    const title = cleanFallbackTitle(r.raw != null ? String(r.raw) : null);
    if (title.length === 0) continue;
    updates.push(`(${sqlString(String(r.session_id))}, ${sqlString(title)})`);
  }
  if (updates.length === 0) return;

  // One UPDATE per chunk instead of one per session — this reruns on every
  // rebuild, so a per-row loop is N round-trips for what is a single join.
  const CHUNK = 1000;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await conn.run(`
      UPDATE sessions SET title = v.title, title_derived = TRUE
      FROM (VALUES ${updates.slice(i, i + CHUNK).join(', ')}) AS v(id, title)
      WHERE sessions.id = v.id
    `);
  }
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
  const pass = doReindex().then(stampLastPass);
  inFlight = pass;
  try {
    return await pass;
  } finally {
    // Only clear our own slot: rebuildIndex may have replaced it while this
    // pass was still draining, and clobbering that would let a new pass run
    // concurrently with the rebuild.
    if (inFlight === pass) inFlight = null;
  }
}

/**
 * Discard the DuckDB file and rebuild the index from scratch (the danger-zone
 * "Rebuild index" action). Runs through the same {@link inFlight} slot as
 * {@link reindex}, so a poller tick during the rebuild coalesces onto it
 * instead of racing the closed connection. Also re-prices all history at the
 * current pricing, since every event is re-stamped at load time.
 */
export async function rebuildIndex(): Promise<ReindexResponse> {
  // Already rebuilding → join the in-flight rebuild.
  if (rebuilding && inFlight) return inFlight;
  const prior = inFlight;
  // Set synchronously — before the prior pass drains — so a second rebuild
  // request during the drain window 409s instead of queueing a redundant
  // second discard-and-rebuild.
  rebuilding = true;
  const run = (async (): Promise<ReindexResponse> => {
    // Let any in-flight pass drain first — passes are uninterruptible and we
    // must not close the connection underneath one.
    if (prior) await prior.catch(() => {});
    ready = false; // health flips to "building"; the web building UX takes over
    try {
      await closeConnection();
      discardDbFiles();
      await getConnection();
      // Empty `files` table ⇒ doReindex reloads everything from the sources.
      return stampLastPass(await doReindex());
    } finally {
      rebuilding = false;
    }
  })();
  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

async function doReindex(): Promise<ReindexResponse> {
  const start = Date.now();
  const conn = await getConnection();
  const pricing = loadPricing();
  const costExpr = buildCostExpr(pricing);
  // The pricing join table is only read by loadFile (its exact-id LEFT JOIN), so
  // build it lazily on the first file load. A no-op reindex — the common 15s
  // auto-poll case — then never pays the DROP/CREATE/INSERT, which matters now
  // that the shipped pricing carries the full OpenAI model lineup.
  let pricingSynced = false;
  const ensurePricingTable = async (): Promise<void> => {
    if (pricingSynced) return;
    await syncPricingTable(conn, pricing);
    pricingSynced = true;
  };

  // Discover across every registered connector, tagging each file with its owner.
  // Isolate per-connector discovery failures: a connector that throws (e.g. a
  // transient SQLite error from the single opencode DB) must NOT abort the whole
  // reindex, NOR have its previously-indexed sessions pruned just because it
  // returned nothing this pass. We record it as "failed this pass" and exclude its
  // files from the prune below (its absence is transient, not a deletion).
  const discovered: { file: DiscoveredFile; connector: AgentConnector }[] = [];
  const failedConnectors = new Set<string>();
  for (const connector of connectors) {
    try {
      for (const file of connector.discover()) discovered.push({ file, connector });
    } catch (err) {
      failedConnectors.add(connector.id);
      console.warn(
        `claudescope: ${connector.id} discovery failed; preserving its indexed sessions this pass:`,
        err,
      );
    }
  }

  // Build a lookup of already-indexed (path -> mtime,size,connector).
  const existingRows = await queryRows(
    conn,
    'SELECT path, mtime_ms, size_bytes, connector_id FROM files',
  );
  const existing = new Map<string, { mtime: number; size: number; connectorId: string | null }>();
  for (const r of existingRows) {
    existing.set(String(r.path), {
      mtime: Number(r.mtime_ms),
      size: Number(r.size_bytes),
      connectorId: r.connector_id != null ? String(r.connector_id) : null,
    });
  }

  const discoveredPaths = new Set(discovered.map((d) => d.file.path));

  // Sessions touched by this pass (files loaded, reloaded, or removed) — the
  // unit `file_edits` extraction is refreshed by (see data/file-edits.ts).
  const editSessions = new Set<string>();

  // Drop files that no longer exist on disk (and their events) — but skip files
  // owned by a connector whose discovery failed this pass (transient, not gone).
  let removed = 0;
  for (const [path, meta] of existing) {
    if (!discoveredPaths.has(path) && !(meta.connectorId && failedConnectors.has(meta.connectorId))) {
      // A removed file's session must re-extract (or drop) its file_edits rows;
      // resolve the ids while the events still exist.
      const gone = await queryRows(
        conn,
        `SELECT DISTINCT session_id FROM events WHERE file_path = ${sqlString(path)}`,
      );
      for (const r of gone) editSessions.add(String(r.session_id ?? ''));
      // Delete stale aux rows before clearing events: the subquery reads events
      // to resolve session ids, so aux deletes must precede the events delete.
      await conn.run(`DELETE FROM titles   WHERE session_id IN (SELECT DISTINCT session_id FROM events WHERE file_path = ${sqlString(path)})`);
      await conn.run(`DELETE FROM pr_links WHERE session_id IN (SELECT DISTINCT session_id FROM events WHERE file_path = ${sqlString(path)})`);
      await conn.run(`DELETE FROM events WHERE file_path = ${sqlString(path)}`);
      await conn.run(`DELETE FROM files WHERE path = ${sqlString(path)}`);
      removed += 1;
    }
  }

  // Precompute the changed set so progress reports a stable total up front.
  const changed = discovered.filter(({ file }) => {
    const prev = existing.get(file.path);
    return !(prev && prev.mtime === file.mtimeMs && prev.size === file.size);
  });

  let reindexed = 0;
  if (changed.length > 0) progress = { processed: 0, total: changed.length };
  // Timestamp of the last mid-pass partial `sessions` rebuild (first build only).
  let lastPartialRebuild = start;
  try {
    for (const { file, connector } of changed) {
      // Isolate per-file failures: a file DuckDB can't read at all (beyond the
      // per-line `ignore_errors` tolerance) must not abort the whole reindex and
      // wedge every other session. Skip it (its `files` row keeps the old mtime,
      // so a later edit retries it) and carry on.
      try {
        await ensurePricingTable();
        await loadFile(conn, connector, file, costExpr);

        // Determine the session id from loaded events (filename usually matches,
        // but the event sessionId is authoritative).
        const sidRows = await queryRows(
          conn,
          `SELECT session_id FROM events WHERE file_path = ${sqlString(file.path)} LIMIT 1`,
        );
        const sessionId = sidRows.length > 0 ? String(sidRows[0]?.session_id ?? '') : null;
        if (sessionId) editSessions.add(sessionId);
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

        // During the first build (server not yet ready), periodically rebuild
        // the derived `sessions` so /api/projects grows while indexing instead
        // of staying empty until the pass finalizes. Deliberately excludes the
        // file-edits refresh (analytics-only) and the FTS rebuild + CHECKPOINT
        // (the expensive, WAL-hazardous part). Steady-state passes skip this.
        if (!ready && Date.now() - lastPartialRebuild >= PARTIAL_REBUILD_MS) {
          await electCanonicalUsage(conn);
          await rebuildSessions(conn);
          lastPartialRebuild = Date.now();
          dataVersion += 1;
        }
      } catch (err) {
        console.warn(`claudescope: skipping unreadable transcript ${file.path}:`, err);
      } finally {
        // Skipped files still advance the counter so processed reaches total.
        if (progress) progress.processed += 1;
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
    // Refresh code-impact rows for the touched sessions, then re-elect the
    // canonical edit per (uuid, tool_use_id) globally (fork copies dedup).
    await refreshFileEdits(conn, editSessions);
    await electCanonicalEdits(conn);
    await rebuildSessions(conn);
    await rebuildFtsIndex(conn);

    ready = true;
    dataVersion += 1;
    return { reindexed, durationMs: Date.now() - start };
  } finally {
    // Progress stays visible through finalization ("finishing up"), then clears.
    progress = null;
  }
}
