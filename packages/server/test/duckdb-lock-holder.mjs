/**
 * Test helper: hold a read-write DuckDB file lock from a SEPARATE process.
 *
 * DuckDB's single-writer lock is per-process, so an in-process open can never
 * reproduce the "Conflicting lock is held in …" failure that a second server
 * (a stray `npm run dev` next to the global daemon, or a racing `claudescope
 * mcp`) hits. Spawned as `node duckdb-lock-holder.mjs <dbPath>`: prints
 * `locked` once the lock is held, then blocks until stdin closes (i.e. until
 * the test kills it), releasing the lock on exit.
 */

import { DuckDBInstance } from '@duckdb/node-api';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: duckdb-lock-holder.mjs <dbPath>');
  process.exit(2);
}

const instance = await DuckDBInstance.create(dbPath);
const connection = await instance.connect();
// Touch the DB so the lock is definitely materialized before we report ready.
await connection.run('SELECT 1');
process.stdout.write('locked\n');

// Park until the parent closes our stdin (or kills us outright).
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
