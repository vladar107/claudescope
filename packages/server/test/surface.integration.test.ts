/**
 * Surface ("started from") indexing — the edges the derivation can get wrong.
 *
 *  1. A desktop session's message rows carry `entrypoint: "claude-desktop"`.
 *  2. A CLI session forked in the desktop app: the fork file's copied rows carry
 *     `forkedFrom` and the origin's `cli` entrypoint at earlier timestamps, so
 *     they must not decide the fork's surface.
 *  3. Subagent rows carry their own entrypoint and must not decide the parent's
 *     surface, even when they are the session's earliest rows that carry one;
 *     reloading the subagent file alone leaves the parent's surface intact.
 *  4. A session with no `entrypoint` has no surface — absent, not `cli`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { FastifyInstance } from 'fastify';
import type { ProjectMeta, ReindexResponse, SessionMeta } from '@claudescope/shared';
import { SESSIONS_TOTAL_HEADER } from '@claudescope/shared';

const work = mkdtempSync(join(tmpdir(), 'claudescope-surface-'));
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

const CWD = '/tmp/surfproj';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

function row(opts: {
  uuid: string;
  sessionId: string;
  minute: number;
  entrypoint?: string;
  sidechain?: boolean;
  forkedFrom?: { sessionId: string; messageUuid: string };
}): Record<string, unknown> {
  const assistant = opts.uuid.includes('-a');
  return {
    type: assistant ? 'assistant' : 'user',
    uuid: opts.uuid,
    parentUuid: null,
    sessionId: opts.sessionId,
    timestamp: `2026-06-01T10:${String(opts.minute).padStart(2, '0')}:00.000Z`,
    cwd: CWD,
    isSidechain: opts.sidechain ?? false,
    ...(opts.entrypoint ? { entrypoint: opts.entrypoint } : {}),
    ...(opts.forkedFrom ? { forkedFrom: opts.forkedFrom } : {}),
    message: assistant
      ? { id: `msg-${opts.uuid}`, role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }] }
      : { role: 'user', content: `prompt ${opts.uuid}` },
  };
}

const proj = join(projectsDir, '-tmp-surfproj');
const withSubFile = join(proj, 'withSub.jsonl');
const subagentFile = join(proj, 'withSub', 'subagents', 'agent-x.jsonl');

function writeFixtures(): void {
  mkdirSync(join(proj, 'withSub', 'subagents'), { recursive: true });

  // Non-message rows carry no entrypoint; they must not matter.
  writeFileSync(join(proj, 'desktop.jsonl'), jsonl([
    { type: 'custom-title', sessionId: 'desktop', customTitle: 'Desk work' },
    row({ uuid: 'd-u1', sessionId: 'desktop', minute: 0, entrypoint: 'claude-desktop' }),
    row({ uuid: 'd-a1', sessionId: 'desktop', minute: 1, entrypoint: 'claude-desktop' }),
  ]));

  writeFileSync(join(proj, 'origin.jsonl'), jsonl([
    row({ uuid: 'o-u1', sessionId: 'origin', minute: 10, entrypoint: 'cli' }),
    row({ uuid: 'o-a1', sessionId: 'origin', minute: 11, entrypoint: 'cli' }),
  ]));
  // The fork repeats the origin's rows (sessionId rewritten, original timestamps
  // and entrypoint kept, `forkedFrom` added), then continues in the desktop app.
  writeFileSync(join(proj, 'fork.jsonl'), jsonl([
    row({ uuid: 'o-u1', sessionId: 'fork', minute: 10, entrypoint: 'cli', forkedFrom: { sessionId: 'origin', messageUuid: 'o-u1' } }),
    row({ uuid: 'o-a1', sessionId: 'fork', minute: 11, entrypoint: 'cli', forkedFrom: { sessionId: 'origin', messageUuid: 'o-a1' } }),
    row({ uuid: 'f-u1', sessionId: 'fork', minute: 20, entrypoint: 'claude-desktop' }),
    row({ uuid: 'f-a1', sessionId: 'fork', minute: 21, entrypoint: 'claude-desktop' }),
  ]));

  // The main thread's first turn predates `entrypoint` (started on an older
  // Claude Code, resumed on a newer one), so the subagent's rows are the
  // session's earliest that carry one.
  writeFileSync(withSubFile, jsonl([
    row({ uuid: 'w-u1', sessionId: 'withSub', minute: 30 }),
    row({ uuid: 'w-a1', sessionId: 'withSub', minute: 31 }),
    row({ uuid: 'w-u2', sessionId: 'withSub', minute: 34, entrypoint: 'cli' }),
    row({ uuid: 'w-a2', sessionId: 'withSub', minute: 35, entrypoint: 'cli' }),
  ]));
  writeFileSync(subagentFile, jsonl([
    row({ uuid: 'w-su1', sessionId: 'withSub', minute: 32, entrypoint: 'sdk-ts', sidechain: true }),
    row({ uuid: 'w-sa1', sessionId: 'withSub', minute: 33, entrypoint: 'sdk-ts', sidechain: true }),
  ]));

  writeFileSync(join(proj, 'plain.jsonl'), jsonl([
    row({ uuid: 'p-u1', sessionId: 'plain', minute: 40, entrypoint: 'cli' }),
  ]));

  // Older Claude Code: no entrypoint field at all.
  writeFileSync(join(proj, 'noEntry.jsonl'), jsonl([
    row({ uuid: 'n-u1', sessionId: 'noEntry', minute: 50 }),
    row({ uuid: 'n-a1', sessionId: 'noEntry', minute: 51 }),
  ]));
}

let reindex: () => Promise<ReindexResponse>;
let conn: DuckDBConnection;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let sqlString: typeof import('../src/db/duckdb.js').sqlString;
let closeConnection: () => Promise<void>;
let app: FastifyInstance;

const surfaceOf = async (id: string): Promise<unknown> =>
  (await queryRows(conn, `SELECT surface FROM sessions WHERE id = ${sqlString(id)}`))[0]?.surface;

const sessions = async (): Promise<Map<string, SessionMeta>> =>
  new Map(
    ((await app.inject({ method: 'GET', url: '/api/sessions' })).json() as SessionMeta[]).map((s) => [s.id, s]),
  );

beforeAll(async () => {
  writeFixtures();
  ({ reindex } = await import('../src/data/index.js'));
  const duck = await import('../src/db/duckdb.js');
  ({ queryRows, sqlString, closeConnection } = duck);
  conn = await duck.getConnection();
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
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

describe('session surface', () => {
  it('reads a desktop session as claude-desktop', async () => {
    expect(await surfaceOf('desktop')).toBe('claude-desktop');
    expect((await sessions()).get('desktop')?.surface).toBe('claude-desktop');
  });

  it('ignores a fork’s copied rows: a CLI session forked in the desktop app started from the desktop', async () => {
    expect(await surfaceOf('origin')).toBe('cli');
    expect(await surfaceOf('fork')).toBe('claude-desktop');
    expect((await sessions()).get('fork')?.surface).toBe('claude-desktop');
  });

  it('leaves the surface absent when no row records an entrypoint', async () => {
    expect(await surfaceOf('noEntry')).toBeNull();
    const meta = (await sessions()).get('noEntry')!;
    expect(meta).toBeDefined();
    expect('surface' in meta).toBe(false);
  });
});

describe('surface filter and project breakdown', () => {
  it('filters /api/sessions by surface and reports the filtered total', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions?surface=claude-desktop&limit=1' });
    expect(res.headers[SESSIONS_TOTAL_HEADER.toLowerCase()]).toBe('2');
    expect((res.json() as SessionMeta[]).length).toBe(1);

    const all = await app.inject({ method: 'GET', url: '/api/sessions?surface=claude-desktop' });
    const rows = all.json() as SessionMeta[];
    expect(rows.map((r) => r.id).sort()).toEqual(['desktop', 'fork']);
    expect(rows.every((r) => r.surface === 'claude-desktop')).toBe(true);
  });

  it('counts each session under exactly one surface, leaving surface-less ones out', async () => {
    const projects = (await app.inject({ method: 'GET', url: '/api/projects' })).json() as ProjectMeta[];
    const p = projects.find((x) => x.cwd === CWD)!;
    const withSurface = [...(await sessions()).values()].filter((s) => s.surface !== undefined);
    expect(p.surfaces.reduce((n, s) => n + s.sessionCount, 0)).toBe(withSurface.length);
    expect(p.sessionCount).toBeGreaterThan(withSurface.length);
    expect(p.surfaces[0]).toEqual({ surface: 'cli', sessionCount: withSurface.filter((s) => s.surface === 'cli').length });
    expect(new Set(p.surfaces.map((s) => s.surface)).size).toBe(p.surfaces.length);
  });
});

describe('subagent files', () => {
  it('ignores subagent rows even when they carry the earliest entrypoint', async () => {
    expect(await surfaceOf('withSub')).toBe('cli');
  });

  it('keeps the parent’s surface when only the subagent file reloads', async () => {
    const later = new Date(Date.now() + 60_000);
    utimesSync(subagentFile, later, later);
    const res = await reindex();
    expect(res.reindexed).toBe(1);
    expect(await surfaceOf('withSub')).toBe('cli');
  });
});
