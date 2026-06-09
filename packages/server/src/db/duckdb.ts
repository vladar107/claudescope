/**
 * DuckDB connection management (DuckDB Node Neo, the modern Promise-based
 * client). Opens the persistent index database, installs/loads the `json` and
 * `fts` extensions, and applies the index schema (idempotent) at startup.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DUCKDB_PATH } from '../config.js';
import { SCHEMA_DDL, SCHEMA_VERSION } from './schema.js';

let connection: DuckDBConnection | null = null;
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
 * Whether the existing DB predates the current {@link SCHEMA_VERSION} and must be
 * rebuilt. A DB with data tables but no matching `meta.schema_version` is a
 * legacy/derived cache from an older shape — caller discards and rebuilds it.
 */
async function isStaleSchema(conn: DuckDBConnection): Promise<boolean> {
  if (!(await tableExists(conn, 'files'))) return false; // brand-new DB
  if (!(await tableExists(conn, 'meta'))) return true; // pre-versioning legacy DB
  const reader = await conn.run('SELECT schema_version FROM meta LIMIT 1');
  const rows = await reader.getRowObjects();
  return Number(rows[0]?.schema_version ?? -1) !== SCHEMA_VERSION;
}

/** Open the DB file, load extensions, and apply the idempotent schema. */
async function openAndPrepare(): Promise<DuckDBConnection> {
  mkdirSync(dirname(DUCKDB_PATH), { recursive: true });
  const instance = await DuckDBInstance.create(DUCKDB_PATH);
  const conn = await instance.connect();
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
  // Stamp the version on a fresh DB (no-op once stamped).
  await conn.run(
    `INSERT INTO meta (schema_version) SELECT ${SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM meta)`,
  );
  return conn;
}

/** Delete the persistent DB file and its WAL/temp siblings. */
function discardCorruptDb(): void {
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
 */
export async function getConnection(): Promise<DuckDBConnection> {
  if (connection) return connection;
  if (connecting) return connecting;

  connecting = (async () => {
    let conn: DuckDBConnection;
    try {
      conn = await openAndPrepare();
    } catch (err) {
      console.warn(
        `[duckdb] failed to open index at ${DUCKDB_PATH}; discarding and rebuilding. Cause:`,
        err instanceof Error ? err.message : err,
      );
      discardCorruptDb();
      conn = await openAndPrepare();
    }
    connection = conn;
    return conn;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function closeConnection(): Promise<void> {
  connection = null;
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
