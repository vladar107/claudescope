/**
 * Claude Code title precedence: the latest non-empty `custom-title` (a user
 * rename, from CLI /rename or the desktop app) beats the latest `ai-title`
 * regardless of file order, and an empty custom-title (name cleared) falls
 * back to the ai-title.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';

const work = mkdtempSync(join(tmpdir(), 'claudescope-custom-title-'));
const projectsDir = join(work, 'projects');
process.env.CLAUDE_PROJECTS_DIR = projectsDir;
for (const v of [
  'CODEX_SESSIONS_DIR',
  'JUNIE_SESSIONS_DIR',
  'PI_SESSIONS_DIR',
  'OPENCODE_DATA_DIR',
  'COPILOT_SESSIONS_DIR',
  'ANTIGRAVITY_CLI_DIR',
  'ANTIGRAVITY_DIR',
  'GROK_SESSIONS_DIR',
]) {
  process.env[v] = join(work, `${v.toLowerCase()}-empty`);
}
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const CWD = '/tmp/customtitleproj';
const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

const user = (sessionId: string) => ({
  type: 'user', uuid: `${sessionId}-u1`, parentUuid: null, sessionId,
  timestamp: '2026-03-01T10:00:00.000Z', cwd: CWD, isSidechain: false,
  message: { role: 'user', content: 'hello' },
});
const ai = (sessionId: string, aiTitle: string) => ({ type: 'ai-title', aiTitle, sessionId });
const custom = (sessionId: string, customTitle: string) => ({ type: 'custom-title', customTitle, sessionId });

let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let closeConnection: () => Promise<void>;
let conn: DuckDBConnection;

beforeAll(async () => {
  const proj = join(projectsDir, 'enc-customtitleproj');
  mkdirSync(proj, { recursive: true });
  const write = (id: string, events: unknown[]) =>
    writeFileSync(join(proj, `${id}.jsonl`), jsonl([user(id), ...events]));
  write('aiThenCustom', [ai('aiThenCustom', 'Auto title'), custom('aiThenCustom', 'My name')]);
  write('customThenAi', [custom('customThenAi', 'My name'), ai('customThenAi', 'Auto title')]);
  write('cleared', [
    ai('cleared', 'Auto title'),
    custom('cleared', 'My name'),
    custom('cleared', ''),
  ]);

  const { reindex } = await import('../src/data/index.js');
  const duck = await import('../src/db/duckdb.js');
  ({ queryRows, closeConnection } = duck);
  conn = await duck.getConnection();
  await reindex();
});

afterAll(async () => {
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

const titleOf = async (id: string): Promise<unknown> =>
  (await queryRows(conn, `SELECT title FROM sessions WHERE id = '${id}'`))[0]?.title;

describe('custom-title precedence', () => {
  it('a custom-title after an ai-title wins', async () => {
    expect(await titleOf('aiThenCustom')).toBe('My name');
  });

  it('a custom-title still wins over a later ai-title', async () => {
    expect(await titleOf('customThenAi')).toBe('My name');
  });

  it('an empty custom-title (name cleared) falls back to the ai-title', async () => {
    expect(await titleOf('cleared')).toBe('Auto title');
  });
});
