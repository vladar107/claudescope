/**
 * Index self-heal recovery tests — the documented "if the index is corrupt,
 * discard and rebuild" contract (db/duckdb.ts), which was previously untested.
 *
 * Two paths through getConnection()'s recovery:
 *  - (2a) a byte-corrupted .duckdb file fails to open → discarded → rebuilt.
 *  - (2b) a valid DB whose persisted schema signature no longer matches →
 *         isStaleSchema throws → discarded → rebuilt.
 *
 * Each scenario uses its own DUCKDB_PATH and re-imports the db/index modules
 * after vi.resetModules(), because DUCKDB_PATH / SCHEMA_SIGNATURE / the
 * connection singleton are all frozen at module import. closeConnection() fully
 * releases the instance (and its file lock) between phases so a reopen exercises
 * the real recovery path rather than a lock conflict. No real ~/.claude is touched.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-recovery-'));
const projectsDir = join(work, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
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
