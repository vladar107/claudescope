/**
 * Index self-heal recovery tests — the documented "if the index is corrupt,
 * discard and rebuild" contract (db/duckdb.ts), which was previously untested.
 *
 * Two paths through getConnection()'s recovery:
 *  - (2a) a byte-corrupted .duckdb file fails to open → discarded → rebuilt.
 *  - (2b) a valid DB whose persisted schema signature no longer matches →
 *         isStaleSchema throws → discarded → rebuilt.
 *
 * Plus the boundary of that contract: a failure the index is NOT to blame for
 * must never reach the discard. A second process holding the DuckDB write lock
 * (the real-world case: `npm run dev` next to the installed daemon) used to be
 * read as corruption and deleted the live daemon's database.
 *
 * Each scenario uses its own DUCKDB_PATH and re-imports the db/index modules
 * after vi.resetModules(), because DUCKDB_PATH / SCHEMA_SIGNATURE / the
 * connection singleton are all frozen at module import. closeConnection() fully
 * releases the instance (and its file lock) between phases so a reopen exercises
 * the real recovery path rather than a lock conflict. No real ~/.claude is touched.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { type ChildProcess, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-recovery-'));
const projectsDir = join(work, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';
process.env.PRICING_REFRESH_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** One tiny Claude session, enough to assert "rebuilt to the same sessions". */
function writeFixture(): void {
  const proj = join(projectsDir, 'enc-projR');
  mkdirSync(proj, { recursive: true });
  const base = { sessionId: 'sessR', cwd: '/tmp/projR', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(proj, 'sessR.jsonl'),
    jsonl([
      { type: 'ai-title', sessionId: 'sessR', aiTitle: 'Session R' },
      { ...base, type: 'user', uuid: 'r-u1', parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'hello recovery' } },
      { ...base, type: 'assistant', uuid: 'r-a1', parentUuid: 'r-u1', timestamp: '2026-01-01T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'recovered' }], usage: { input_tokens: 100, output_tokens: 50 } } },
    ]),
  );
}

writeFixture();

/** Re-import the db + index modules against a fresh DUCKDB_PATH. */
async function loadDbModules(dbPath: string) {
  process.env.DUCKDB_PATH = dbPath;
  vi.resetModules();
  const { getConnection, closeConnection, queryRows } = await import('../src/db/duckdb.js');
  const { reindex } = await import('../src/data/index.js');
  return { getConnection, closeConnection, queryRows, reindex };
}

type DbModules = Awaited<ReturnType<typeof loadDbModules>>;

/** The derived output we compare before/after a rebuild. */
async function snapshot(db: DbModules): Promise<{ ids: unknown[]; events: number }> {
  const conn = await db.getConnection();
  const ids = (await db.queryRows(conn, 'SELECT id FROM sessions ORDER BY id')).map((r) => r.id);
  const rows = await db.queryRows(conn, 'SELECT count(*) AS n FROM events');
  return { ids, events: Number(rows[0]?.n ?? 0) };
}

/** The catch in getConnection logs this when it discards a bad DB. */
const RECOVERY_LOG = 'discarding and rebuilding';

/** Standalone script that holds the DuckDB write lock from another process —
 *  DuckDB's lock is per-process, so an in-process open can't reproduce it. */
const LOCK_HOLDER = fileURLToPath(new URL('./duckdb-lock-holder.mjs', import.meta.url));

/** Spawn the lock holder and resolve once it reports the lock is held. */
async function holdLock(dbPath: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [LOCK_HOLDER, dbPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock holder never reported ready')), 20_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (chunk.includes('locked')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`lock holder exited early (${code})`));
    });
  });
  return child;
}

/** Release the lock and wait for the holder to actually be gone. */
async function releaseLock(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.stdin?.end();
  child.kill();
  await exited;
}

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('byte-corrupted index file', () => {
  it('is discarded and rebuilt to the same sessions on the next open', async () => {
    const dbPath = join(work, 'corrupt.duckdb');

    // Build a valid index, capture the baseline, fully close to release the lock.
    let db = await loadDbModules(dbPath);
    await db.reindex();
    const before = await snapshot(db);
    expect(before.ids).toEqual(['sessR']);
    expect(before.events).toBeGreaterThan(0);
    await db.closeConnection();

    // Corrupt the file: clobber the header with garbage and drop the WAL.
    writeFileSync(dbPath, randomBytes(8192));
    rmSync(`${dbPath}.wal`, { force: true });

    // Reconnect in a fresh module: open fails → discard → clean rebuild.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db = await loadDbModules(dbPath);
    await expect(db.getConnection()).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(RECOVERY_LOG), expect.anything());
    warn.mockRestore();

    await db.reindex();
    expect(await snapshot(db)).toEqual(before);
    await db.closeConnection();
  });
});

describe('stale schema signature', () => {
  it('forces a discard + rebuild to the same sessions', async () => {
    const dbPath = join(work, 'stale.duckdb');

    let db = await loadDbModules(dbPath);
    await db.reindex();
    const before = await snapshot(db);
    expect(before.ids).toEqual(['sessR']);

    // Tamper the persisted signature, flush it to disk, then fully close.
    const conn = await db.getConnection();
    await conn.run(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_signature', 'STALE-DOES-NOT-MATCH')",
    );
    await conn.run('CHECKPOINT');
    await db.closeConnection();

    // Reconnect: isStaleSchema sees the mismatch → discard → clean rebuild.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db = await loadDbModules(dbPath);
    await expect(db.getConnection()).resolves.toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(RECOVERY_LOG), expect.anything());
    warn.mockRestore();

    await db.reindex();
    expect(await snapshot(db)).toEqual(before);

    // The signature was re-stamped to a real sha1, not the tampered sentinel.
    const conn2 = await db.getConnection();
    const rows = await db.queryRows(conn2, "SELECT value FROM meta WHERE key = 'schema_signature'");
    expect(rows[0]?.value).not.toBe('STALE-DOES-NOT-MATCH');
    expect(String(rows[0]?.value)).toMatch(/^[0-9a-f]{40}$/);
    await db.closeConnection();
  });
});

// Windows: DuckDB's Windows build let a second read-write open through in CI
// (no "Could not set lock" error was raised), so the conflict this scenario
// provokes never happens there. The classification itself is platform-neutral
// and covered by duckdb-open.test.ts; this proves the end-to-end behaviour on
// the POSIX builds that do enforce the single-writer lock.
describe.skipIf(process.platform === 'win32')('index locked by another process', () => {
  it('reports the conflict and leaves the database on disk', async () => {
    const dbPath = join(work, 'locked.duckdb');

    // Build a valid index, then fully flush + close so the holder sees a
    // settled file (nothing left for it to replay and rewrite).
    let db = await loadDbModules(dbPath);
    await db.reindex();
    const before = await snapshot(db);
    expect(before.ids).toEqual(['sessR']);
    const conn = await db.getConnection();
    await conn.run('CHECKPOINT');
    await db.closeConnection();
    const sizeBefore = statSync(dbPath).size;

    const holder = await holdLock(dbPath);
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      db = await loadDbModules(dbPath);
      // The old behaviour: treat this as corruption, delete the daemon's index.
      await expect(db.getConnection()).rejects.toThrow(/lock/i);
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining(RECOVERY_LOG),
        expect.anything(),
      );
      warn.mockRestore();

      expect(existsSync(dbPath)).toBe(true);
      expect(statSync(dbPath).size).toBe(sizeBefore);
    } finally {
      await releaseLock(holder);
    }

    // `connecting` was reset in the finally, so the next call really retries —
    // and finds the same index, never rebuilt.
    expect(await snapshot(db)).toEqual(before);
    await db.closeConnection();
  });
});

describe('DuckDB extension directory', () => {
  it('is redirected to the configured dir, not DuckDB’s default', async () => {
    const dbPath = join(work, 'extdir.duckdb');
    const db = await loadDbModules(dbPath);
    const { DUCKDB_EXTENSION_DIR } = await import('../src/config.js');

    const conn = await db.getConnection();
    const rows = await db.queryRows(conn, "SELECT current_setting('extension_directory') AS dir");
    expect(rows[0]?.dir).toBe(DUCKDB_EXTENSION_DIR);
    await db.closeConnection();
  });
});
