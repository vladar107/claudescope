/**
 * Settings API integration test — GET/PUT /api/settings against a real index,
 * using the Grok connector as the guinea pig for the FILE layer: no
 * GROK_SESSIONS_DIR env var is set; instead a pre-written settings.json in the
 * temp CLAUDESCOPE_HOME points grokSessionsDir at a fixture dir. This exercises
 * the whole runtime-settings chain: file-sourced resolution surfaces on GET,
 * a PUT re-points the connector live (the next pass indexes the new dir and
 * prunes the old), env-shadowed saves warn without changing the effective
 * value, and invalid patches are rejected atomically (file untouched).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-settings-api-'));
const home = join(work, 'home');
const settingsPath = join(home, 'settings.json');
const claudeDir = join(work, 'claude-empty');
const grokDirA = join(work, 'grok-a');
const grokDirB = join(work, 'grok-b');

process.env.CLAUDE_PROJECTS_DIR = claudeDir; // env-sourced row + shadow-warning test
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = home;
process.env.REINDEX_INTERVAL_MS = '0';
// The point of this suite: the grok dir comes from settings.json, NOT env.
// resolveSetting reads env per call, so an inherited var would shadow the file.
delete process.env.GROK_SESSIONS_DIR;

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const BASE_MS = Date.parse('2026-06-20T10:00:00.000Z');
const iso = (s: number) => new Date(BASE_MS + s * 1000).toISOString();

/** Minimal Grok session dir: chat_history.jsonl + summary.json (no updates). */
function writeGrokSession(sessionsDir: string, id: string, prompt: string): void {
  const dir = join(sessionsDir, '%2Ftmp%2Fsettingsproj', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      info: { id, cwd: '/tmp/settingsproj' },
      created_at: iso(0),
      updated_at: iso(60),
      current_model_id: 'grok-4.5',
      generated_title: `Session ${id}`,
    }),
  );
  writeFileSync(
    join(dir, 'chat_history.jsonl'),
    jsonl([
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: `<user_query>\n${prompt}\n</user_query>` }] },
      { type: 'assistant', content: 'done', model_id: 'grok-4.5' },
    ]),
  );
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(claudeDir, { recursive: true });
  writeGrokSession(grokDirA, 'grok-sess-a', 'session living in dir A');
  writeGrokSession(grokDirB, 'grok-sess-b', 'session living in dir B');
  // Pre-write the settings file the server will read at the first resolve.
  mkdirSync(home, { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({ schemaVersion: 1, grokSessionsDir: grokDirA }, null, 2)}\n`);

  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');
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

const get = (url: string) => app.inject({ method: 'GET', url });
const put = (set: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: '/api/settings', payload: { set } });
const sessionIds = async (): Promise<string[]> =>
  ((await get('/api/sessions')).json() as { id: string }[]).map((s) => s.id).sort();

type SettingsBody = {
  schemaVersion: number;
  editable: Record<string, unknown>[];
  readOnly: Record<string, unknown>[];
};
const row = (body: SettingsBody, key: string) => body.editable.find((r) => r.key === key)!;

describe('GET /api/settings', () => {
  it('reports the file-sourced grok row and the env-sourced claude row with provenance', async () => {
    const res = await get('/api/settings');
    expect(res.statusCode).toBe(200);
    const body = res.json() as SettingsBody;
    expect(body.schemaVersion).toBe(1);

    // File layer: value comes from settings.json (no env var set).
    expect(row(body, 'grokSessionsDir')).toMatchObject({
      source: 'file',
      effective: grokDirA,
      fileValue: grokDirA,
      exists: true,
      connectorId: 'grok',
      type: 'path',
      envVar: 'GROK_SESSIONS_DIR',
      live: true,
    });

    // Env layer: the harness sets CLAUDE_PROJECTS_DIR, so env wins.
    const claude = row(body, 'claudeProjectsDir');
    expect(claude).toMatchObject({ source: 'env', effective: claudeDir, exists: true });
    expect(claude.fileValue).toBeUndefined();

    // Read-only infra rows ride along for transparency.
    const homeRow = body.readOnly.find((r) => r.key === 'claudescopeHome');
    expect(homeRow).toMatchObject({ source: 'env' });
    expect(body.readOnly.some((r) => r.key === 'port')).toBe(true);
  });

  it('indexes sessions from the file-configured grok dir', async () => {
    expect(await sessionIds()).toEqual(['grok-sess-a']);
    const sessions = (await get('/api/sessions')).json() as { id: string; connectorId: string }[];
    expect(sessions[0]!.connectorId).toBe('grok');
  });
});

describe('PUT /api/settings', () => {
  it('re-points the grok source dir live: dir B appears, dir A is pruned', async () => {
    const res = await put({ grokSessionsDir: grokDirB });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      settings: SettingsBody;
      applied: { key: string; live: boolean }[];
      warnings: unknown[];
    };
    expect(body.applied).toContainEqual({ key: 'grokSessionsDir', live: true });
    expect(body.warnings).toEqual([]);
    expect(row(body.settings, 'grokSessionsDir')).toMatchObject({
      source: 'file',
      effective: grokDirB,
      exists: true,
    });

    // The PUT kicks requestPass fire-and-forget; a POST /api/reindex serializes
    // behind it (reindex coalesces on the in-flight pass), so after this await
    // the post-save discovery has definitely completed.
    const re = await app.inject({ method: 'POST', url: '/api/reindex' });
    expect(re.statusCode).toBe(200);

    expect(await sessionIds()).toEqual(['grok-sess-b']); // A's session pruned
  });

  it('saves an env-shadowed key with a warning; the effective value stays env', async () => {
    const claudeAlt = join(work, 'claude-alt');
    mkdirSync(claudeAlt, { recursive: true });

    const res = await put({ claudeProjectsDir: claudeAlt });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { settings: SettingsBody; warnings: { key: string; message: string }[] };
    expect(body.warnings).toContainEqual({
      key: 'claudeProjectsDir',
      message: expect.stringContaining('$CLAUDE_PROJECTS_DIR'),
    });

    // Saved to the file, but env keeps winning until the var is unset.
    expect(row(body.settings, 'claudeProjectsDir')).toMatchObject({
      source: 'env',
      effective: claudeDir,
      fileValue: claudeAlt,
    });
    const onDisk = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.claudeProjectsDir).toBe(claudeAlt);
  });

  it('rejects an invalid interval with per-field errors and leaves the file untouched', async () => {
    const before = readFileSync(settingsPath, 'utf8');
    const res = await put({ reindexIntervalMs: 500 });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; fields: Record<string, string> };
    expect(body.fields.reindexIntervalMs).toMatch(/1000/);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('rejects an unknown key', async () => {
    const res = await put({ nonsenseKey: '/x' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { fields: Record<string, string> }).fields.nonsenseKey).toBe(
      'unknown setting',
    );
  });

  it('rejects a malformed body (missing or empty set)', async () => {
    const noSet = await app.inject({ method: 'PUT', url: '/api/settings', payload: {} });
    expect(noSet.statusCode).toBe(400);
    const emptySet = await put({});
    expect(emptySet.statusCode).toBe(400);
  });
});
