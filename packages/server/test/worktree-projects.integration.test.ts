/**
 * Claude Code worktrees group under their repo, and resume runs from the
 * directory a session started in.
 *
 *  1. Parity: the TS fold and the SQL fold (DuckDB's RE2) agree on every path
 *     shape, including Windows separators and look-alikes that must not fold.
 *  2. A root session whose `isolation: "worktree"` subagent rows outnumber its
 *     main thread still belongs to the repo and resumes at the repo.
 *  3. A session started inside a worktree belongs to the repo but resumes in
 *     the worktree — Claude Code files the transcript under that directory.
 *  4. A session that starts at the repo and moves into a worktree resumes at
 *     the repo, even though most of its rows are in the worktree.
 *  5. `--cwd <worktree>` and `resolve` from inside a worktree reach the repo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { FastifyInstance } from 'fastify';
import type { ProjectMeta, SessionDetailResponse } from '@claudescope/shared';

const work = mkdtempSync(join(tmpdir(), 'claudescope-worktree-'));
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

const REPO = '/tmp/wtrepo';
const AGENT_WT = `${REPO}/.claude/worktrees/agent-x`;
const FEAT_WT = `${REPO}/.claude/worktrees/feat`;

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

function row(opts: {
  uuid: string;
  sessionId: string;
  minute: number;
  cwd?: string;
  sidechain?: boolean;
}): Record<string, unknown> {
  const assistant = opts.uuid.includes('-a');
  return {
    type: assistant ? 'assistant' : 'user',
    uuid: opts.uuid,
    parentUuid: null,
    sessionId: opts.sessionId,
    timestamp: `2026-05-01T10:${String(opts.minute).padStart(2, '0')}:00.000Z`,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    isSidechain: opts.sidechain ?? false,
    message: assistant
      ? { id: `msg-${opts.uuid}`, role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }] }
      : { role: 'user', content: `prompt ${opts.uuid}` },
  };
}

function writeFixtures(): void {
  const repoDir = join(projectsDir, '-tmp-wtrepo');
  mkdirSync(join(repoDir, 'rootSub', 'subagents'), { recursive: true });
  writeFileSync(join(repoDir, 'rootSub.jsonl'), jsonl([
    row({ uuid: 'r-u1', sessionId: 'rootSub', minute: 0, cwd: REPO }),
    row({ uuid: 'r-a1', sessionId: 'rootSub', minute: 1, cwd: REPO }),
  ]));
  writeFileSync(join(repoDir, 'rootSub', 'subagents', 'agent-x.jsonl'), jsonl(
    [2, 3, 4, 5].map((m, i) =>
      row({ uuid: `r-s${i % 2 ? 'a' : 'u'}${m}`, sessionId: 'rootSub', minute: m, cwd: AGENT_WT, sidechain: true }),
    ),
  ));

  const featDir = join(projectsDir, '-tmp-wtrepo--claude-worktrees-feat');
  mkdirSync(featDir, { recursive: true });
  writeFileSync(join(featDir, 'startWt.jsonl'), jsonl([
    row({ uuid: 'w-u1', sessionId: 'startWt', minute: 10, cwd: FEAT_WT }),
    row({ uuid: 'w-a1', sessionId: 'startWt', minute: 11, cwd: FEAT_WT }),
  ]));

  writeFileSync(join(repoDir, 'movesIn.jsonl'), jsonl([
    row({ uuid: 'm-u1', sessionId: 'movesIn', minute: 20, cwd: REPO }),
    row({ uuid: 'm-a1', sessionId: 'movesIn', minute: 21, cwd: FEAT_WT }),
    row({ uuid: 'm-u2', sessionId: 'movesIn', minute: 22, cwd: FEAT_WT }),
    row({ uuid: 'm-a2', sessionId: 'movesIn', minute: 23, cwd: FEAT_WT }),
  ]));

  // A sidechain row with an earlier ts than the main thread's first cwd.
  mkdirSync(join(repoDir, 'sideFirst', 'subagents'), { recursive: true });
  writeFileSync(join(repoDir, 'sideFirst.jsonl'), jsonl([
    row({ uuid: 'f-u1', sessionId: 'sideFirst', minute: 30 }),
    row({ uuid: 'f-a1', sessionId: 'sideFirst', minute: 32, cwd: REPO }),
  ]));
  writeFileSync(join(repoDir, 'sideFirst', 'subagents', 'agent-x.jsonl'), jsonl([
    row({ uuid: 'f-su1', sessionId: 'sideFirst', minute: 31, cwd: AGENT_WT, sidechain: true }),
  ]));

  // Only sidechain rows carry a cwd.
  mkdirSync(join(repoDir, 'sideOnly', 'subagents'), { recursive: true });
  writeFileSync(join(repoDir, 'sideOnly.jsonl'), jsonl([
    row({ uuid: 'o-u1', sessionId: 'sideOnly', minute: 40 }),
  ]));
  writeFileSync(join(repoDir, 'sideOnly', 'subagents', 'agent-x.jsonl'), jsonl([
    row({ uuid: 'o-su1', sessionId: 'sideOnly', minute: 42, cwd: AGENT_WT, sidechain: true }),
    row({ uuid: 'o-su2', sessionId: 'sideOnly', minute: 41, cwd: FEAT_WT, sidechain: true }),
  ]));
}

type ProjectIdModule = typeof import('../src/data/project-id.js');

// Imported after the env above is set: the db module reads it on load.
let projectCwdFromCwd: ProjectIdModule['projectCwdFromCwd'];
let projectCwdSql: ProjectIdModule['projectCwdSql'];
let projectIdFromCwd: ProjectIdModule['projectIdFromCwd'];
let WORKTREE_FOLD_PATTERN: string;
let projectIdForCwd: typeof import('../src/agent/shape.js').projectIdForCwd;
let matchProject: typeof import('../src/agent/resolve.js').matchProject;
let conn: DuckDBConnection;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let sqlString: typeof import('../src/db/duckdb.js').sqlString;
let closeConnection: () => Promise<void>;
let app: FastifyInstance;

const detail = async (id: string): Promise<SessionDetailResponse> =>
  (await app.inject({ method: 'GET', url: `/api/sessions/${id}` })).json() as SessionDetailResponse;

beforeAll(async () => {
  writeFixtures();
  ({ projectCwdFromCwd, projectCwdSql, projectIdFromCwd, WORKTREE_FOLD_PATTERN } = await import('../src/data/project-id.js'));
  ({ projectIdForCwd } = await import('../src/agent/shape.js'));
  ({ matchProject } = await import('../src/agent/resolve.js'));
  const { reindex } = await import('../src/data/index.js');
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

describe('worktree fold parity (TS vs DuckDB)', () => {
  const cases: [string, string][] = [
    ['/r/.claude/worktrees/a', '/r'],
    ['C:\\r\\.claude\\worktrees\\a', 'C:\\r'],
    ['C:\\r\\.claude/worktrees\\a\\sub', 'C:\\r'],
    ['/r/.claude/worktrees/a/.claude/worktrees/b', '/r'],
    ['/r/.claude/worktrees/a/src/deep', '/r'],
    ['/r/.claude/worktrees', '/r/.claude/worktrees'],
    ['/r/.claude/worktrees/', '/r/.claude/worktrees/'],
    ['/r/.claude/worktrees-old/x', '/r/.claude/worktrees-old/x'],
    ['/r/xclaude/worktrees/a', '/r/xclaude/worktrees/a'],
    ['/.claude/worktrees/a', '/.claude/worktrees/a'],
    ['/r/src', '/r/src'],
  ];

  it('quotes the pattern safely inline (no single quote in it)', () => {
    expect(WORKTREE_FOLD_PATTERN).not.toContain("'");
  });

  it.each(cases)('%s → %s', async (input, expected) => {
    expect(projectCwdFromCwd(input)).toBe(expected);
    const rows = await queryRows(conn, `SELECT ${projectCwdSql(sqlString(input))} AS folded`);
    expect(rows[0]?.folded).toBe(expected);
  });
});

describe('worktree sessions', () => {
  it('keeps a root session with worktree subagents in the repo, resuming at the repo', async () => {
    const d = await detail('rootSub');
    expect(d.meta.projectId).toBe(projectIdFromCwd(REPO));
    expect(d.resume?.cwd).toBe(REPO);
  });

  it('groups a session started in a worktree under the repo but resumes in the worktree', async () => {
    const d = await detail('startWt');
    expect(d.meta.projectId).toBe(projectIdFromCwd(REPO));
    expect(d.resume?.cwd).toBe(FEAT_WT);
  });

  it('resumes a session that moved into a worktree from where it started', async () => {
    const d = await detail('movesIn');
    expect(d.meta.projectId).toBe(projectIdFromCwd(REPO));
    expect(d.resume?.cwd).toBe(REPO);
  });

  it('resumes from the main thread even when a subagent recorded a cwd earlier', async () => {
    expect((await detail('sideFirst')).resume?.cwd).toBe(REPO);
  });

  it('falls back to the earliest subagent cwd when the main thread has none', async () => {
    expect((await detail('sideOnly')).resume?.cwd).toBe(FEAT_WT);
  });

  it('lists one repo project and no worktree projects', async () => {
    const projects = (await app.inject({ method: 'GET', url: '/api/projects' })).json() as ProjectMeta[];
    expect(projects.map((p) => p.cwd)).toEqual([REPO]);
    expect(projects[0]?.sessionCount).toBe(5);
  });
});

describe('worktree cwd lookups', () => {
  it('`--cwd <worktree>` and resolve from a worktree reach the repo project', async () => {
    expect(projectIdForCwd(`${FEAT_WT}/sub`)).toBe(projectIdFromCwd(REPO));
    const projects = (await app.inject({ method: 'GET', url: '/api/projects' })).json() as ProjectMeta[];
    expect(matchProject(projects, `${FEAT_WT}/sub`, '/Users/nobody')?.id).toBe(projectIdFromCwd(REPO));
  });
});
