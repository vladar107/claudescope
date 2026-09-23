/**
 * Integration tests for `collectMemory`'s store-first attribution (issue #116).
 * Claude Code keys a project memory dir by the git repo root, so one dir can
 * hold facts whose `originSessionId` belongs to a session that ran in a
 * subdirectory/worktree/submodule of that repo, indexed as a DIFFERENT
 * Claudescope project. Builds a real DuckDB index from synthetic Claude Code
 * session fixtures in a temp dir — never touches ~/.claude.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-memory-attr-'));
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
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** A minimal two-turn session transcript recorded at the given cwd. */
function sessionEvents(sessionId: string, cwd: string): unknown[] {
  const base = { sessionId, cwd, gitBranch: 'main', version: '2.1.0' };
  return [
    { ...base, type: 'user', uuid: `${sessionId}-u1`, parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'start' } },
    { ...base, type: 'assistant', uuid: `${sessionId}-a1`, parentUuid: `${sessionId}-u1`, timestamp: '2026-01-01T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
}

/** `<projectsDir>/<dirName>/<sessionId>.jsonl` — session discovery walks the whole tree. */
function writeSession(dirName: string, sessionId: string, cwd: string): void {
  const dir = join(projectsDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl(sessionEvents(sessionId, cwd)));
}

/** A fact file as Claude Code writes it: flat frontmatter + markdown body. */
function factFile(name: string, originSessionId: string): string {
  return `---\nname: ${name}\ntype: project\noriginSessionId: ${originSessionId}\n---\n\n${name} body.\n`;
}

function writeFixtures(): void {
  // --- Case 1: parent repo + submodule. The memory dir is keyed by the
  // parent repo root's slug; one of its facts originates from a session that
  // ran (and is indexed) in the submodule subdirectory.
  writeSession('proj-parent', 'sess-parent', '/tmp/parentRepo');
  writeSession('proj-sub', 'sess-sub', '/tmp/parentRepo/sub');
  const parentMemory = join(projectsDir, '-tmp-parentRepo', 'memory');
  mkdirSync(parentMemory, { recursive: true });
  writeFileSync(join(parentMemory, 'fact-parent.md'), factFile('fact-parent', 'sess-parent'));
  writeFileSync(join(parentMemory, 'fact-sub.md'), factFile('fact-sub', 'sess-sub'));

  // --- Case 2: the dir's slug matches no indexed project (no session ever ran
  // exactly at `/tmp/otherRepo`) — two facts originate from module A, one from
  // module B; the whole dir must go to the majority (module A).
  writeSession('proj-module-a', 'sess-a1', '/tmp/otherRepo/moduleA');
  writeSession('proj-module-b', 'sess-b1', '/tmp/otherRepo/moduleB');
  const otherMemory = join(projectsDir, '-tmp-otherRepo', 'memory');
  mkdirSync(otherMemory, { recursive: true });
  writeFileSync(join(otherMemory, 'fact-a1.md'), factFile('fact-a1', 'sess-a1'));
  writeFileSync(join(otherMemory, 'fact-a2.md'), factFile('fact-a2', 'sess-a1'));
  writeFileSync(join(otherMemory, 'fact-b1.md'), factFile('fact-b1', 'sess-b1'));

  // --- Case 3: neither the slug nor any fact's origin resolves — the dir is
  // dropped entirely, as before.
  const unresolvedMemory = join(projectsDir, '-tmp-unresolved', 'memory');
  mkdirSync(unresolvedMemory, { recursive: true });
  writeFileSync(join(unresolvedMemory, 'fact-ghost.md'), factFile('fact-ghost', 'sess-does-not-exist'));
}

let collectMemory: typeof import('../src/data/memory.js').collectMemory;
let reindex: typeof import('../src/data/index.js').reindex;
let closeConnection: () => Promise<void>;
let projectIdFromCwd: typeof import('../src/data/project-id.js').projectIdFromCwd;

beforeAll(async () => {
  writeFixtures();
  ({ reindex } = await import('../src/data/index.js'));
  ({ closeConnection } = await import('../src/db/duckdb.js'));
  ({ collectMemory } = await import('../src/data/memory.js'));
  ({ projectIdFromCwd } = await import('../src/data/project-id.js'));
  await reindex();
});

afterAll(async () => {
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('collectMemory — store-first attribution (issue #116)', () => {
  it('attributes every fact in a dir to the project that owns the dir, not each fact\'s origin session', async () => {
    const items = await collectMemory();
    const parentId = projectIdFromCwd('/tmp/parentRepo');
    const subId = projectIdFromCwd('/tmp/parentRepo/sub');

    const parentTitles = items
      .filter((it) => it.connectorId === 'claude-code' && it.projectId === parentId)
      .map((it) => it.source.title)
      .sort();
    expect(parentTitles).toEqual(['fact-parent', 'fact-sub']);

    // The submodule project gets nothing from this store — it owns no memory dir.
    const subTitles = items.filter((it) => it.connectorId === 'claude-code' && it.projectId === subId);
    expect(subTitles).toEqual([]);
  });

  it('assigns an unmatched-slug dir to the majority origin project, and drops a dir with no resolvable origin', async () => {
    const items = await collectMemory();
    const moduleAId = projectIdFromCwd('/tmp/otherRepo/moduleA');
    const moduleBId = projectIdFromCwd('/tmp/otherRepo/moduleB');

    const moduleATitles = items
      .filter((it) => it.connectorId === 'claude-code' && it.projectId === moduleAId)
      .map((it) => it.source.title)
      .sort();
    expect(moduleATitles).toEqual(['fact-a1', 'fact-a2', 'fact-b1']);

    const moduleBTitles = items.filter((it) => it.connectorId === 'claude-code' && it.projectId === moduleBId);
    expect(moduleBTitles).toEqual([]);

    const ghostTitles = items.filter((it) => it.source.title === 'fact-ghost');
    expect(ghostTitles).toEqual([]);
  });
});
