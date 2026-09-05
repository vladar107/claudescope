/**
 * Open-failure classification (db/duckdb.ts). getConnection() deletes the index
 * on a failed open, so what counts as "corrupt" is a destructive decision: a
 * lock conflict once wiped the running daemon's database from under it, because
 * a second process (a stray `npm run dev`, a racing `claudescope mcp`) shares
 * the same state dir. These cases pin down which failures may trigger that
 * discard and which must be rethrown untouched — with the REAL DuckDB messages.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { isNonCorruptionOpenError } from '../src/db/duckdb.js';

/** Verbatim from a second process opening the daemon's index (DuckDB v1.5). */
const LOCK_CONFLICT =
  'IO Error: Could not set lock on file "/Users/u/.claudescope/index.duckdb": ' +
  'Conflicting lock is held in /opt/homebrew/bin/node (PID 66590) by user u. ' +
  'See also https://duckdb.org/docs/stable/connect/concurrency';

describe('isNonCorruptionOpenError', () => {
  it('never discards on a lock conflict — another process owns a healthy index', () => {
    expect(isNonCorruptionOpenError(new Error(LOCK_CONFLICT))).toBe(true);
  });

  it('never discards when the json/fts extensions cannot be installed', () => {
    const cases = [
      // Verbatim shape of a failed INSTALL (DuckDB v1.5, unreachable repository).
      'HTTP Error: Failed to download extension "fts" at URL ' +
        '"http://extensions.duckdb.org/v1.5.3/osx_arm64/fts.duckdb_extension.gz" (HTTP 404)',
      'IO Error: Extension "json" not found. Extension "json" is an existing extension.',
      'Extension "fts" could not be loaded: the file was not found',
      "HTTP Error: HTTP GET error on " +
        "'http://extensions.duckdb.org/v1.5.3/linux_amd64/json.duckdb_extension.gz' (HTTP 403)",
      'IO Error: Could not establish connection to extensions.duckdb.org',
    ];
    for (const message of cases) {
      expect(isNonCorruptionOpenError(new Error(message)), message).toBe(true);
    }
  });

  it('never discards on an OS permission/disk failure, by code or by message', () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(isNonCorruptionOpenError(denied)).toBe(true);
    expect(isNonCorruptionOpenError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(true);
    const full = new Error("ENOSPC: no space left on device, write '/x/index.duckdb'");
    expect(isNonCorruptionOpenError(full)).toBe(true);
  });

  it('still rebuilds on the stale-schema sentinel and on real corruption', () => {
    const rebuildable = [
      'index schema is stale (expected v21); rebuilding',
      'IO Error: The file "/Users/u/.claudescope/index.duckdb" exists, ' +
        'but it is not a valid DuckDB database file!',
      // An unreplayable WAL is the original reason the discard path exists.
      'IO Error: Failure while replaying WAL file "index.duckdb.wal"',
    ];
    for (const message of rebuildable) {
      expect(isNonCorruptionOpenError(new Error(message)), message).toBe(false);
    }
    expect(isNonCorruptionOpenError(undefined)).toBe(false);
  });
});

describe('DUCKDB_EXTENSION_DIR', () => {
  // No DuckDB instance is opened here on purpose: that would download the
  // extensions into this throwaway home.
  const home = mkdtempSync(join(tmpdir(), 'claudescope-extdir-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('defaults under CLAUDESCOPE_HOME when the override is unset', async () => {
    const saved = { ext: process.env.DUCKDB_EXTENSION_DIR, home: process.env.CLAUDESCOPE_HOME };
    delete process.env.DUCKDB_EXTENSION_DIR;
    process.env.CLAUDESCOPE_HOME = home;
    try {
      vi.resetModules();
      const config = await import('../src/config.js');
      expect(config.DUCKDB_EXTENSION_DIR).toBe(join(home, 'duckdb-extensions'));
    } finally {
      if (saved.ext === undefined) delete process.env.DUCKDB_EXTENSION_DIR;
      else process.env.DUCKDB_EXTENSION_DIR = saved.ext;
      if (saved.home === undefined) delete process.env.CLAUDESCOPE_HOME;
      else process.env.CLAUDESCOPE_HOME = saved.home;
      vi.resetModules();
    }
  });
});
