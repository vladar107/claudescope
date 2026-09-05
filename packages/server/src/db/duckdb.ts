/**
 * DuckDB connection management (DuckDB Node Neo, the modern Promise-based
 * client). Opens the persistent index database, installs/loads the `json` and
 * `fts` extensions, and applies the index schema (idempotent) at startup.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import {
  DEFAULT_DUCKDB_EXTENSION_DIR,
  DUCKDB_EXTENSION_DIR,
  DUCKDB_PATH,
  ensureStateDir,
} from '../config.js';
import { SCHEMA_DDL, SCHEMA_VERSION } from './schema.js';

/**
 * A fingerprint of the persisted schema. Derived from the DDL text (+ version),
 * so ANY change to a table shape — not just a manual version bump — changes the
 * signature and forces a rebuild. This is what makes the derived-cache migration
 * robust: a stamp can never get "ahead" of the actual schema.
 */
const SCHEMA_SIGNATURE = createHash('sha1')
  .update(`v${SCHEMA_VERSION}\n${SCHEMA_DDL.join('\n')}`)
  .digest('hex');

let connection: DuckDBConnection | null = null;
let instance: DuckDBInstance | null = null;
let connecting: Promise<DuckDBConnection> | null = null;

/** Does a table exist in the open database? */
async function tableExists(conn: DuckDBConnection, name: string): Promise<boolean> {
  const reader = await conn.run(
    `SELECT count(*) AS n FROM information_schema.tables WHERE table_name = '${name}'`,
  );
  const rows = await reader.getRowObjects();
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Whether the existing DB's schema differs from the current {@link SCHEMA_SIGNATURE}
 * and must be rebuilt. A populated DB whose stored signature is absent or
 * different is a derived cache from an older (or partially-built) shape — the
 * caller discards and rebuilds it. Reading a legacy/incompatible `meta` shape
 * throws, which we treat as stale.
 */
async function isStaleSchema(conn: DuckDBConnection): Promise<boolean> {
  if (!(await tableExists(conn, 'files'))) return false; // brand-new DB
  if (!(await tableExists(conn, 'meta'))) return true; // pre-versioning legacy DB
  try {
    const reader = await conn.run("SELECT value FROM meta WHERE key = 'schema_signature'");
    const rows = await reader.getRowObjects();
    return String(rows[0]?.value ?? '') !== SCHEMA_SIGNATURE;
  } catch {
    return true; // old `meta` shape (no key/value columns) → rebuild
  }
}

/** Open the DB file, load extensions, and apply the idempotent schema. */
async function openAndPrepare(): Promise<{ conn: DuckDBConnection; inst: DuckDBInstance }> {
  // Owner-only: DuckDB creates index.duckdb itself (we can't pass a mode), so
  // the 0700 directory is what keeps the indexed transcript corpus private.
  ensureStateDir(dirname(DUCKDB_PATH));
  // The default extension dir is app-owned state and gets the owner-only mode;
  // an override may be a shared cache (the tests point at ~/.duckdb/extensions)
  // whose mode is not ours to change — create it, never chmod it.
  if (DUCKDB_EXTENSION_DIR === DEFAULT_DUCKDB_EXTENSION_DIR) ensureStateDir(DUCKDB_EXTENSION_DIR);
  else mkdirSync(DUCKDB_EXTENSION_DIR, { recursive: true });
  const inst = await DuckDBInstance.create(DUCKDB_PATH);
  try {
    return await prepare(inst);
  } catch (err) {
    // Anything that throws past the open must release the file lock: the caller
    // either discards the file (which needs it closed) or rethrows to a process
    // that may retry later.
    try {
      inst.closeSync();
    } catch {
      /* already closed */
    }
    throw err;
  }
}

/** Configure the open instance and apply the schema. Split out of
 *  {@link openAndPrepare} so every failure below shares one lock-release path. */
async function prepare(inst: DuckDBInstance): Promise<{
  conn: DuckDBConnection;
  inst: DuckDBInstance;
}> {
  const conn = await inst.connect();
  // The node client bundles neither extension, so DuckDB downloads them the
  // first time (and after each DuckDB version bump). Redirect that write into
  // our own state dir — see DUCKDB_EXTENSION_DIR.
  await conn.run(`SET extension_directory = ${sqlString(DUCKDB_EXTENSION_DIR)}`);
  await conn.run('INSTALL json; LOAD json;');
  await conn.run('INSTALL fts; LOAD fts;');

  // A schema-version mismatch means the persisted shape is outdated. The index
  // is a derived cache, so signal a discard+rebuild rather than migrate in place.
  if (await isStaleSchema(conn)) {
    throw new Error(`index schema is stale (expected v${SCHEMA_VERSION}); rebuilding`);
  }

  for (const ddl of SCHEMA_DDL) {
    await conn.run(ddl);
  }
  // Stamp the current schema signature (idempotent).
  await conn.run(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_signature', '${SCHEMA_SIGNATURE}')`,
  );
  return { conn, inst };
}

/** DuckDB's single-writer guard, e.g. `IO Error: Could not set lock on file
 *  "…/index.duckdb": Conflicting lock is held in …/bin/node (PID 66590) by user
 *  …`. Another live process owns the index; the file itself is fine. */
const LOCK_CONFLICT = /Could not set lock on file/i;

/** OS-level failures to open/write the file: no permission, or no space. */
const OS_FAILURE = /\b(EACCES|EPERM|ENOSPC)\b/;

/**
 * Whether an open failure came from installing/loading the `json`/`fts`
 * extensions rather than from the database file. DuckDB downloads them from its
 * extension repository, so an offline or proxy-blocked machine fails here with a
 * perfectly healthy index. The generic network markers only count when the
 * message also mentions an extension — a corrupt-file message quoting a path
 * must never be mistaken for a download failure.
 */
function isExtensionFailure(message: string): boolean {
  if (/Failed to download extension/i.test(message)) return true;
  if (/IO Error: Extension/i.test(message)) return true;
  if (/Could not establish connection/i.test(message)) return true;
  if (!/extension/i.test(message)) return false;
  return /could not be loaded|not found|\bHTTP\b/i.test(message);
}

/**
 * Whether an open failure is something OTHER than a corrupt index — a lock held
 * by another process, an extension that couldn't be installed, or an OS-level
 * permission/disk error. None of those are fixed by deleting the index, and
 * deleting it on a lock conflict destroys the *live* daemon's database (a second
 * server — a stray `npm run dev` beside the global daemon, or a racing
 * `claudescope mcp` — shares the same state dir). Everything else, including the
 * stale-schema sentinel and an unreplayable WAL, stays rebuildable.
 */
export function isNonCorruptionOpenError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === 'string' && OS_FAILURE.test(code)) return true;

  const message = err instanceof Error ? err.message : String(err ?? '');
  if (LOCK_CONFLICT.test(message) || OS_FAILURE.test(message)) return true;
  return isExtensionFailure(message);
}

/** Wrap a non-corruption open failure in an actionable error (original kept as
 *  `cause`), naming what to do about it instead of silently rebuilding. */
function describeOpenFailure(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err ?? '');
  let hint: string;
  if (LOCK_CONFLICT.test(message)) {
    const holder = message.match(/Conflicting lock is held in (.+?) by user/)?.[1];
    hint =
      `another Claudescope (or other DuckDB) process already holds the index lock — ` +
      `${holder ?? 'holder unknown'}. Stop it (\`claudescope stop\`) or run this one ` +
      `against a different DUCKDB_PATH; the index was left untouched.`;
  } else if (isExtensionFailure(message)) {
    hint =
      `the DuckDB \`json\`/\`fts\` extensions could not be installed. They are ` +
      `downloaded once from DuckDB's extension repository into ${DUCKDB_EXTENSION_DIR} ` +
      `(override: DUCKDB_EXTENSION_DIR), so this needs network access — or a copy of ` +
      `that directory. The index was left untouched.`;
  } else {
    hint =
      `the index file is not usable (check permissions and free disk space). ` +
      `It was left untouched.`;
  }
  return new Error(`[duckdb] cannot open index at ${DUCKDB_PATH}: ${hint} Cause: ${message}`, {
    cause: err,
  });
}

/** Delete the persistent DB file and its WAL/temp siblings. Used by the
 *  corrupt-open recovery below and by the explicit rebuild-index action —
 *  callers must {@link closeConnection} first to release the file lock. */
export function discardDbFiles(): void {
  for (const suffix of ['', '.wal', '.tmp']) {
    rmSync(`${DUCKDB_PATH}${suffix}`, { force: true, recursive: true });
  }
}

/**
 * Open (or reuse) the singleton DuckDB connection backed by the persistent
 * index file, ensuring required extensions and tables exist. Concurrent
 * callers during startup share a single in-flight connect promise.
 *
 * The DB is a pure *derived cache* — fully rebuildable from the source JSONL —
 * so if opening fails (e.g. a WAL that can't be replayed after the process was
 * killed mid-write, a known hazard with FTS index DDL), we discard the file and
 * rebuild from scratch rather than wedging startup. The subsequent reindex
 * repopulates it.
 *
 * That discard applies ONLY to evidence of corruption. A failure the index isn't
 * to blame for — another process holding the lock, an extension that couldn't be
 * downloaded, a permission/disk error ({@link isNonCorruptionOpenError}) — is
 * rethrown with an actionable message and leaves every file on disk alone.
 * Rebuilding there would delete a healthy (possibly live) index.
 */
export async function getConnection(): Promise<DuckDBConnection> {
  if (connection) return connection;
  if (connecting) return connecting;

  connecting = (async () => {
    let opened: { conn: DuckDBConnection; inst: DuckDBInstance };
    try {
      opened = await openAndPrepare();
    } catch (err) {
      if (isNonCorruptionOpenError(err)) throw describeOpenFailure(err);
      console.warn(
        `[duckdb] failed to open index at ${DUCKDB_PATH}; discarding and rebuilding. Cause:`,
        err instanceof Error ? err.message : err,
      );
      discardDbFiles();
      opened = await openAndPrepare();
    }
    connection = opened.conn;
    instance = opened.inst;
    return opened.conn;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Close the open connection and release the underlying DB instance (and its
 *  file lock). Best-effort: a double-close or already-closed handle is ignored. */
export async function closeConnection(): Promise<void> {
  try {
    connection?.disconnectSync();
  } catch {
    /* already closed */
  }
  try {
    instance?.closeSync();
  } catch {
    /* already closed */
  }
  connection = null;
  instance = null;
}

/**
 * Run a query and return its rows as plain objects, converting DuckDB `BIGINT`
 * (returned as JS `bigint`) to `number`. Token/cost magnitudes in this dataset
 * are well within Number.MAX_SAFE_INTEGER, so the narrowing is safe here.
 */
export async function queryRows(
  conn: DuckDBConnection,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const reader = await conn.run(sql);
  const rows = await reader.getRowObjects();
  return rows.map(normalizeRow);
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

/** Escape a string for safe inclusion inside a single-quoted SQL literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Backslash-escape LIKE wildcards (`%`, `_`) and `\` itself so a user-supplied
 * string matches literally inside a LIKE pattern. The LIKE must carry
 * `ESCAPE '\'` for the escapes to take effect.
 */
export function sqlLikeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Escape a filesystem path for safe use as the pattern argument of
 * `read_ndjson`/`read_json` (and friends), which treat that string as a GLOB,
 * not a literal path: `*`, `?`, and `[` are metacharacters. A path containing
 * one — e.g. a Claude Code project dir encoded from a cwd with `[1]` in it —
 * silently reads whichever OTHER file matches the resulting glob instead of
 * itself (`read_ndjson('/x/x[1].jsonl')` returns the contents of `/x/x1.jsonl`).
 * Wrapping each metacharacter in its own single-char bracket class makes it
 * literal (`x[1].jsonl` → `x[[]1].jsonl`); `]` needs no escaping here since it
 * only acts as a metacharacter when paired with an opening `[`, which this
 * function already neutralizes.
 *
 * Only for the glob argument itself — anywhere the path is COMPARED (e.g. the
 * `file_path` column, or a `DELETE … WHERE file_path = …`) must keep using the
 * raw path via {@link sqlString}, or file identity breaks.
 */
export function sqlPath(path: string): string {
  return sqlString(path.replace(/[*?[]/g, (c) => `[${c}]`));
}
