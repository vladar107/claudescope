/**
 * Session-fingerprint integration tests — the GET /api/sessions/:id/fingerprint
 * contract (data/fingerprint.ts): the probe live-stats the session's files, so
 * transcript growth flips the token with NO reindex; a brand-new subagent file
 * is invisible until a reindex pass records its `files` row (the documented
 * ≤ REINDEX_INTERVAL_MS blind spot), then flips it; unknown sessions 404.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-fingerprint-'));
const projectsDir = join(work, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

const proj = join(projectsDir, 'enc-projF');
const sessFile = join(proj, 'sessF.jsonl');
const subDir = join(proj, 'sessF', 'subagents');

const base = { sessionId: 'sessF', cwd: '/tmp/projF', gitBranch: 'main', version: '2.1.0' };

function writeFixtures(): void {
  mkdirSync(subDir, { recursive: true });
  writeFileSync(
    sessFile,
    jsonl([
      { ...base, type: 'user', uuid: 'f-u1', parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'start' } },
      { ...base, type: 'assistant', uuid: 'f-a1', parentUuid: 'f-u1', timestamp: '2026-01-01T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 10, output_tokens: 5 } } },
    ]),
  );
}

let app: FastifyInstance;
let reindex: typeof import('../src/data/index.js').reindex;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  writeFixtures();
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  ({ reindex } = await import('../src/data/index.js'));
  ({ closeConnection } = await import('../src/db/duckdb.js'));
  app = Fastify();
  await registerRoutes(app);
  await reindex();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

const getFingerprint = async (id: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}/fingerprint` });
  return { status: res.statusCode, body: res.json() as { fingerprint: string; lastModifiedMs: number } };
};

describe('GET /api/sessions/:id/fingerprint', () => {
  it('is stable while nothing changes and flips on file growth WITHOUT a reindex', async () => {
    const first = await getFingerprint('sessF');
    expect(first.status).toBe(200);
    expect(first.body.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(first.body.lastModifiedMs).toBeGreaterThan(0);

    const second = await getFingerprint('sessF');
    expect(second.body.fingerprint).toBe(first.body.fingerprint);

    // Append one event — size changes even when mtime lands in the same ms, so
    // the assertion is timing-proof. Deliberately NO reindex() call here: the
    // probe must see growth live, straight from disk.
    appendFileSync(
      sessFile,
      jsonl([
        { ...base, type: 'assistant', uuid: 'f-a2', parentUuid: 'f-a1', timestamp: '2026-01-01T10:00:10.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'more' }], usage: { input_tokens: 10, output_tokens: 5 } } },
      ]),
    );

    const grown = await getFingerprint('sessF');
    expect(grown.status).toBe(200);
    expect(grown.body.fingerprint).not.toBe(first.body.fingerprint);
    expect(grown.body.lastModifiedMs).toBeGreaterThanOrEqual(first.body.lastModifiedMs);
  });

  it('sees a brand-new subagent file only after a reindex records its files row', async () => {
    const before = await getFingerprint('sessF');

    // A subagent transcript spawned mid-session: a new file the `files` table
    // doesn't know yet, so the probe can't include it — the documented
    // ≤ REINDEX_INTERVAL_MS blind spot.
    writeFileSync(
      join(subDir, 'agent-bbbb.jsonl'),
      jsonl([
        { ...base, type: 'user', uuid: 'fs-u1', parentUuid: null, agentId: 'bbbb', isSidechain: true, timestamp: '2026-01-01T10:01:00.000Z', message: { role: 'user', content: 'subagent task' } },
      ]),
    );
    const unchanged = await getFingerprint('sessF');
    expect(unchanged.body.fingerprint).toBe(before.body.fingerprint);

    // The reindex pass discovers the file and keys it to sessF (via the events'
    // session_id), which flips the fingerprint through the row-count prefix.
    await reindex();
    const after = await getFingerprint('sessF');
    expect(after.body.fingerprint).not.toBe(before.body.fingerprint);
  });

  it('404s for an unknown session, matching the detail route error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope/fingerprint' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Session not found' });
  });
});
