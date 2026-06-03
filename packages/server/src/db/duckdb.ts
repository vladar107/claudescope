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
import { SCHEMA_DDL } from './schema.js';

let connection: DuckDBConnection | null = null;
let connecting: Promise<DuckDBConnection> | null = null;

/** Open the DB file, load extensions, and apply the idempotent schema. */
async function openAndPrepare(): Promise<DuckDBConnection> {
  mkdirSync(dirname(DUCKDB_PATH), { recursive: true });
  const instance = await DuckDBInstance.create(DUCKDB_PATH);
  const conn = await instance.connect();
  await conn.run('INSTALL json; LOAD json;');
  await conn.run('INSTALL fts; LOAD fts;');
  for (const ddl of SCHEMA_DDL) {
    await conn.run(ddl);
  }
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
