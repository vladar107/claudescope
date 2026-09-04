/**
 * GitHub Copilot CLI connector integration test.
 *
 * Builds the index from two synthetic Copilot sessions (in an isolated temp
 * COPILOT_SESSIONS_DIR, the other agents empty) and exercises the routes,
 * verifying the Copilot-specific normalization:
 *   - cwd/branch from `session.start`, model from `assistant.message`, title from
 *     the sibling `workspace.yaml` (`name`);
 *   - session-level tokens from `session.shutdown` (gpt-5-mini priced correctly),
 *     and a session WITHOUT a shutdown event costing zero;
 *   - encrypted reasoning (`reasoningOpaque`) → empty thinking block (Codex-style);
 *   - a SAVED screenshot (`files/<displayName>`) → base64 ImageBlock, while an
 *     unsaved one keeps only the inline `[📷 …]` marker;
 *   - a SUCCESSFUL `edit` → canonical `Edit` (feeds Files-changed), while a DENIED
 *     edit passes through under its raw name (excluded from Files-changed);
 *   - an unknown event type (`session.context_changed`) tolerated;
 *   - an inline subagent (`subagent.started` + `agentId`-tagged events) segmented
 *     out of the main thread and nested under a canonical `Task` block, with a
 *     stray `agentId` (no started record) tolerated as a detached run;
 *   - a symlinked saved attachment escaping `files/` refused (symlink-safe
 *     containment);
 *   - global memory read from `~/.copilot/copilot-instructions.md`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const work = mkdtempSync(join(tmpdir(), 'claudescope-copilot-'));
const copilotHome = join(work, 'copilot');
const sessionsDir = join(copilotHome, 'session-state');

process.env.CLAUDE_PROJECTS_DIR = join(work, 'claude-empty');
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = sessionsDir;
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ts = (s: number) => `2026-06-16T10:00:${String(s).padStart(2, '0')}.000Z`;
let evtId = 0;
/** Wrap a `{type, data}` pair into a Copilot event envelope. */
const ev = (type: string, data: unknown) => ({ type, data, id: `e${evtId++}`, timestamp: ts(evtId), parentId: null });
/** Tag an event as belonging to an inline subagent run. */
const sub = (e: Record<string, unknown>, agentId: string) => ({ ...e, agentId });

// Bytes a poisoned symlink points at — must never surface in an API response.
const SECRET_B64 = Buffer.from('copilot-secret-bytes').toString('base64');

// 1x1 transparent PNG — stands in for a saved screenshot.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Write a session dir: events.jsonl + workspace.yaml (+ optional saved files). */
function writeSession(
  uuid: string,
  workspaceName: string,
  events: unknown[],
  files: Record<string, Buffer> = {},
): void {
  const dir = join(sessionsDir, uuid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), jsonl(events));
  writeFileSync(
    join(dir, 'workspace.yaml'),
    `id: ${uuid}\ncwd: /tmp/cproj\ngit_root: /tmp/cproj\nrepository: me/cproj\nbranch: main\nname: ${workspaceName}\nuser_named: false\n`,
  );
  const fileNames = Object.keys(files);
  if (fileNames.length > 0) {
    mkdirSync(join(dir, 'files'), { recursive: true });
    for (const name of fileNames) writeFileSync(join(dir, 'files', name), files[name]!);
  }
}

/** Session 1: clean shutdown, a successful edit, and a SAVED screenshot. */
function writeSession1(): void {
  writeSession(
    'sa',
    'Fix the bug',
    [
      ev('session.start', {
        sessionId: 'copilot-sess-1',
        copilotVersion: '1.0.62',
        context: { cwd: '/tmp/cproj', gitRoot: '/tmp/cproj', branch: 'main', repository: 'me/cproj', hostType: 'github' },
      }),
      ev('session.model_change', { newModel: 'gpt-5-mini', reasoningEffort: 'medium' }),
      ev('user.message', {
        content: 'fix the bug and here is a shot [📷 shot.png]',
        transformedContent: '<current_datetime>…</current_datetime>\n\nfix the bug…',
        attachments: [{ type: 'file', path: '/var/folders/T/shot.png', displayName: 'shot.png' }],
      }),
      ev('assistant.message', {
        messageId: 'm1',
        model: 'gpt-5-mini',
        content: "I'll fix it.",
        reasoningOpaque: 'ENCRYPTED_REASONING_BLOB',
        toolRequests: [
          { toolCallId: 'call-edit', name: 'edit', arguments: { path: '/tmp/cproj/app.ts', old_str: 'bug', new_str: 'fixed' } },
        ],
      }),
      ev('tool.execution_start', { toolCallId: 'call-edit', toolName: 'edit', arguments: { path: '/tmp/cproj/app.ts', old_str: 'bug', new_str: 'fixed' }, model: 'gpt-5-mini' }),
      ev('tool.execution_complete', { toolCallId: 'call-edit', success: true, result: { content: 'File app.ts updated with changes.' } }),
      // Only `reason: compaction` is a compaction marker; other reasons stay skipped.
      ev('session.context_changed', { reason: 'model_change' }),
      ev('session.context_changed', { reason: 'compaction' }),
      ev('user.message', { content: 'carry on from the summary' }),
      ev('assistant.message', { messageId: 'm1b', model: 'gpt-5-mini', content: 'resumed with room to spare' }),
      ev('session.shutdown', {
        tokenDetails: { input: { tokenCount: 100 }, cache_read: { tokenCount: 20 }, output: { tokenCount: 50 } },
        codeChanges: { linesAdded: 1, linesRemoved: 1, filesModified: ['/tmp/cproj/app.ts'] },
        modelMetrics: { 'gpt-5-mini': { requests: { count: 1, cost: 0 }, usage: { inputTokens: 120, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 30 } } },
      }),
    ],
    { 'shot.png': Buffer.from(PNG_B64, 'base64') },
  );
}

/** Session 2: NO shutdown (→ zero cost), a DENIED edit, an UNSAVED screenshot. */
function writeSession2(): void {
  writeSession('sb', 'Audit the project', [
    ev('session.start', {
      sessionId: 'copilot-sess-2',
      context: { cwd: '/tmp/cproj', branch: 'main', repository: 'me/cproj', hostType: 'github' },
    }),
    ev('session.model_change', { newModel: 'gpt-5-mini' }),
    ev('user.message', {
      content: 'audit the code and see this needle [📷 missing.png]',
      attachments: [{ type: 'file', path: '/var/folders/T/missing.png', displayName: 'missing.png' }],
    }),
    ev('assistant.message', {
      messageId: 'm2',
      model: 'gpt-5-mini',
      content: 'I will edit CLAUDE.md',
      toolRequests: [
        { toolCallId: 'call-deny', name: 'edit', arguments: { path: '/tmp/cproj/CLAUDE.md', old_str: 'x', new_str: 'y' } },
      ],
    }),
    ev('permission.requested', {
      requestId: 'r1',
      permissionRequest: { kind: 'write', toolCallId: 'call-deny', intention: 'Edit file', fileName: '/tmp/cproj/CLAUDE.md', diff: '@@ -1 +1 @@\n-x\n+y' },
    }),
    ev('permission.completed', { requestId: 'r1', toolCallId: 'call-deny', result: { kind: 'denied-interactively-by-user' } }),
    ev('abort', { reason: 'user_initiated' }),
  ]);
}

/** Session 3: an inline `task` subagent (started + tagged events + completed),
 *  a stray tagged turn with no `subagent.started`, and a POISONED saved
 *  attachment — `files/evil.png` is a symlink escaping the session dir. */
function writeSession3(): void {
  writeSession('sc', 'Explore with subagent', [
    ev('session.start', {
      sessionId: 'copilot-sess-3',
      context: { cwd: '/tmp/cproj', branch: 'main', repository: 'me/cproj', hostType: 'github' },
    }),
    ev('session.model_change', { newModel: 'gpt-5-mini' }),
    ev('user.message', {
      content: 'inspect the entry point [📷 evil.png]',
      attachments: [{ type: 'file', path: '/var/folders/T/evil.png', displayName: 'evil.png' }],
    }),
    ev('assistant.message', {
      messageId: 'm3',
      model: 'gpt-5-mini',
      content: 'Delegating to the explore agent.',
      toolRequests: [
        { toolCallId: 'call-task', name: 'task', arguments: { description: 'Inspect entry point', prompt: 'Find the entry point of this repo.' } },
      ],
    }),
    sub(ev('subagent.started', { toolCallId: 'call-task', agentName: 'explore', agentDisplayName: 'Explore Agent', model: 'gpt-5-mini' }), 'call-task'),
    sub(ev('assistant.message', {
      model: 'gpt-5-mini',
      content: 'Scanning for the zebrafinder entry.',
      toolRequests: [{ toolCallId: 'call-sub-view', name: 'view', arguments: { path: '/tmp/cproj/package.json' } }],
    }), 'call-task'),
    sub(ev('tool.execution_start', { toolCallId: 'call-sub-view', toolName: 'view' }), 'call-task'),
    sub(ev('tool.execution_complete', { toolCallId: 'call-sub-view', success: true, result: { content: '{"main":"src/index.ts"}' } }), 'call-task'),
    // The subagent run compacts: the marker belongs to ITS stream, not the main one.
    sub(ev('session.context_changed', { reason: 'compaction' }), 'call-task'),
    sub(ev('assistant.message', { model: 'gpt-5-mini', content: 'resumed the zebrafinder scan' }), 'call-task'),
    // The subagent spawns a subagent: the `task` call is made from ITS stream, so
    // the inner Task block belongs to the outer run and the inner events open a
    // stream of their own.
    sub(ev('assistant.message', {
      model: 'gpt-5-mini',
      content: 'Delegating the manifest read.',
      toolRequests: [
        { toolCallId: 'call-inner', name: 'task', arguments: { description: 'Read the manifest', prompt: 'Read package.json and report.' } },
      ],
    }), 'call-task'),
    sub(ev('subagent.started', { toolCallId: 'call-inner', agentName: 'read', agentDisplayName: 'Read Agent', model: 'gpt-5-mini' }), 'call-task'),
    sub(ev('assistant.message', { model: 'gpt-5-mini', content: 'the narwhalmanifest names src/index.ts' }), 'call-inner'),
    sub(ev('subagent.completed', { toolCallId: 'call-inner', agentName: 'read' }), 'call-task'),
    sub(ev('tool.execution_complete', { toolCallId: 'call-inner', success: true, result: { content: 'The manifest names src/index.ts.' } }), 'call-task'),
    sub(ev('subagent.completed', { toolCallId: 'call-task', agentName: 'explore' }), 'call-task'),
    ev('tool.execution_complete', { toolCallId: 'call-task', success: true, result: { content: 'Entry point is src/index.ts.' } }),
    // A tagged turn with no subagent.started — tolerated as a detached run.
    sub(ev('assistant.message', { model: 'gpt-5-mini', content: 'ghost turn from a lost agent' }), 'call-ghost'),
    ev('assistant.message', { messageId: 'm4', model: 'gpt-5-mini', content: 'The entry point is src/index.ts.' }),
  ]);
  // The poisoned attachment: textually inside files/, target outside the session.
  const secret = join(work, 'secret-outside.png');
  writeFileSync(secret, Buffer.from(SECRET_B64, 'base64'));
  mkdirSync(join(sessionsDir, 'sc', 'files'), { recursive: true });
  symlinkSync(secret, join(sessionsDir, 'sc', 'files', 'evil.png'));
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  writeSession1();
  writeSession2();
  writeSession3();
  // Global memory file in the Copilot home (parent of session-state).
  writeFileSync(join(copilotHome, 'copilot-instructions.md'), '# User profile\nuser.name: Vlad\n');

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
type Session = { id: string; connectorId: string; title: string; models: string[]; totalTokens: number; totalCostUsd: number; hasSidechain: boolean };
const sessionById = async (id: string): Promise<Session> =>
  (await get('/api/sessions')).json().find((s: Session) => s.id === id);

describe('copilot session indexing', () => {
  it('lists the sessions tagged copilot, with model and workspace.yaml title', async () => {
    const sessions: Session[] = (await get('/api/sessions')).json();
    expect(sessions.map((s) => s.id).sort()).toEqual(['copilot-sess-1', 'copilot-sess-2', 'copilot-sess-3']);
    for (const s of sessions) {
      expect(s.connectorId).toBe('copilot');
      expect(s.models).toContain('gpt-5-mini');
    }
    expect((await sessionById('copilot-sess-1')).title).toBe('Fix the bug');
    expect((await sessionById('copilot-sess-2')).title).toBe('Audit the project');
    // The inline subagent flips has_sidechain on (and only there).
    expect((await sessionById('copilot-sess-3')).hasSidechain).toBe(true);
    expect((await sessionById('copilot-sess-1')).hasSidechain).toBe(false);
  });

  it('prices the shutdown session from tokenDetails and charges the no-shutdown session nothing', async () => {
    const s1 = await sessionById('copilot-sess-1');
    // tokenDetails: input 100 + cache_read 20 + output 50 = 170 (one billed row).
    expect(s1.totalTokens).toBe(170);
    // gpt-5-mini @ 0.25 / 2 / 0.025 per 1M (cacheWrite 0):
    //   (100*0.25 + 50*2 + 20*0.025)/1e6 = (25 + 100 + 0.5)/1e6 = 0.0001255.
    expect(s1.totalCostUsd).toBeCloseTo(0.0001255, 8);

    // No session.shutdown → no token data → zero cost (not an error).
    const s2 = await sessionById('copilot-sess-2');
    expect(s2.totalTokens).toBe(0);
    expect(s2.totalCostUsd).toBe(0);
  });

  it('exposes the copilot source and groups analytics by the copilot agent', async () => {
    const sources = (await get('/api/sources')).json();
    expect(sources.some((s: { id: string }) => s.id === 'copilot')).toBe(true);
    const { rows } = (await get('/api/analytics?groupBy=agent')).json();
    expect(rows.map((r: { key: string }) => r.key)).toContain('copilot');
  });

  it('finds a copilot session via full-text search', async () => {
    const { sessions: results } = (await get('/api/search?q=needle')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === 'copilot-sess-2')).toBe(true);
  });

  it('surfaces the global copilot-instructions.md memory', async () => {
    const { global } = (await get('/api/memory')).json();
    const copilot = global.find((g: { connectorId: string }) => g.connectorId === 'copilot');
    expect(copilot).toBeTruthy();
    expect(copilot.label).toBe('GitHub Copilot CLI');
    expect(JSON.stringify(copilot.sources)).toContain('copilot-instructions.md (global)');
  });
});

describe('copilot session detail', () => {
  it('renders empty thinking, a saved screenshot, and a canonical Edit feeding Files-changed', async () => {
    const detail = (await get('/api/sessions/copilot-sess-1')).json();
    expect(detail.subagents).toEqual([]);
    expect(detail.thread[0]).toMatchObject({ role: 'user', parentUuid: null });

    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);

    // reasoningOpaque → empty thinking block (encrypted; Codex-style empty render).
    const thinking = flat.find((b: Record<string, unknown>) => b.type === 'thinking');
    expect(thinking).toBeTruthy();
    expect(thinking.thinking).toBe('');

    // Saved screenshot resolved from files/shot.png → base64 ImageBlock (carried
    // in the thread as an attachment block).
    const att = flat.find((b: Record<string, unknown>) => b.kind === 'attachment');
    expect(att.attachment).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_B64 },
    });
    // The inline marker the user typed survives in the message text.
    expect(JSON.stringify(detail.thread)).toContain('[📷 shot.png]');

    // Successful edit → canonical Edit (what changeset.ts keys off for Files-changed).
    const tools = flat.filter((b: Record<string, unknown>) => b.kind === 'tool');
    const edit = tools.find((t: { name: string }) => t.name === 'Edit');
    expect(edit.input).toEqual({ file_path: '/tmp/cproj/app.ts', old_string: 'bug', new_string: 'fixed' });
    expect(JSON.stringify(edit.result.content)).toContain('updated');
  });

  it('keeps a denied edit out of Files-changed and only marks the attachment when bytes are absent', async () => {
    const detail = (await get('/api/sessions/copilot-sess-2')).json();
    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);
    const tools = flat.filter((b: Record<string, unknown>) => b.kind === 'tool');

    // Denied edit must NOT become a canonical Edit/Write (else it'd show in Files-changed).
    expect(tools.some((t: { name: string }) => t.name === 'Edit' || t.name === 'Write')).toBe(false);
    const denied = tools.find((t: { name: string }) => t.name === 'edit');
    expect(denied).toBeTruthy();
    expect(JSON.stringify(denied.result.content)).toContain('denied');

    // Unsaved screenshot: no attachment block, but the inline marker remains.
    expect(flat.some((b: Record<string, unknown>) => b.kind === 'attachment')).toBe(false);
    expect(JSON.stringify(detail.thread)).toContain('[📷 missing.png]');
  });
});

describe('copilot subagent embedding', () => {
  type Block = Record<string, any>;
  type Run = Record<string, any>;

  it('segments the tagged run out of the main thread and nests it under a canonical Task block', async () => {
    const detail = (await get('/api/sessions/copilot-sess-3')).json();
    const flat: Block[] = detail.thread.flatMap((t: { blocks: Block[] }) => t.blocks);

    // Main thread: no subagent turns leaked (its text and tools live in the run).
    expect(JSON.stringify(detail.thread)).not.toContain('zebrafinder');
    expect(detail.thread.every((t: { isSidechain?: boolean }) => !t.isSidechain)).toBe(true);

    // The spawning `task` call is canonicalized to Task, its result (the final
    // report) intact.
    const task = flat.find((b) => b.kind === 'tool' && b.name === 'Task');
    expect(task.input).toEqual({
      description: 'Inspect entry point',
      subagent_type: 'explore',
      prompt: 'Find the entry point of this repo.',
    });
    expect(JSON.stringify(task.result.content)).toContain('Entry point is src/index.ts');

    // The run is anchored to that Task block and carries the subagent's turns.
    const runs: Run[] = detail.subagents;
    expect(runs).toHaveLength(3);
    const run = runs.find((r) => r.agentType === 'explore');
    expect(run).toMatchObject({ description: 'Inspect entry point', toolUseId: task.id });
    expect(run.parentAgentId).toBeUndefined(); // spawned from the main thread
    expect(run.spawnUuid).toBeTruthy();
    expect(JSON.stringify(run.thread)).toContain('zebrafinder');
    const runBlocks: Block[] = run.thread.flatMap((t: { blocks: Block[] }) => t.blocks);
    const view = runBlocks.find((b) => b.kind === 'tool' && b.name === 'Read');
    expect(view.input.file_path).toBe('/tmp/cproj/package.json');
    expect(JSON.stringify(view.result.content)).toContain('src/index.ts');
  });

  it('nests a subagent spawned by a subagent under the inner Task call', async () => {
    const detail = (await get('/api/sessions/copilot-sess-3')).json();
    const outer = detail.subagents.find((r: Run) => r.agentId === 'call-task');
    const outerBlocks: Block[] = outer.thread.flatMap((t: { blocks: Block[] }) => t.blocks);

    // The inner `task` call is canonicalized inside the OUTER run's thread, and
    // the main thread never sees it.
    const innerTask = outerBlocks.find((b) => b.kind === 'tool' && b.name === 'Task');
    expect(innerTask).toMatchObject({ id: 'call-inner' });
    expect(innerTask.input).toMatchObject({ description: 'Read the manifest', subagent_type: 'read' });
    expect(JSON.stringify(detail.thread)).not.toContain('narwhalmanifest');

    // `agentId` IS the spawning toolCallId, so the run anchors by exact id and
    // reports the outer run as its parent.
    const inner = detail.subagents.find((r: Run) => r.agentId === 'call-inner');
    expect(inner).toMatchObject({
      agentType: 'read',
      description: 'Read the manifest',
      toolUseId: 'call-inner',
      parentAgentId: 'call-task',
    });
    const spawnTurn = outer.thread.find((t: { blocks: Block[] }) =>
      t.blocks.some((b: Block) => b.id === 'call-inner'),
    );
    expect(inner.spawnUuid).toBe(spawnTurn.uuid);
    expect(JSON.stringify(inner.thread)).toContain('narwhalmanifest');
  });

  it('tolerates a tagged turn with no subagent.started as a detached run', async () => {
    const detail = (await get('/api/sessions/copilot-sess-3')).json();
    const ghost = detail.subagents.find((r: Run) => r.agentId === 'call-ghost');
    expect(ghost).toBeTruthy();
    expect(JSON.stringify(ghost.thread)).toContain('ghost turn');
    // No started record → no description → never matched to a spawn point.
    expect(ghost.toolUseId).toBeUndefined();
  });

  it('finds subagent text via full-text search under the parent session', async () => {
    const { sessions: results } = (await get('/api/search?q=zebrafinder')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === 'copilot-sess-3')).toBe(true);
  });

  it('refuses a saved attachment whose symlink escapes files/', async () => {
    const detail = (await get('/api/sessions/copilot-sess-3')).json();
    const flat: Block[] = detail.thread.flatMap((t: { blocks: Block[] }) => t.blocks);
    // No attachment block for the poisoned name — only the inline marker survives —
    // and the symlink target's bytes never appear anywhere in the response.
    expect(flat.some((b) => b.kind === 'attachment')).toBe(false);
    expect(JSON.stringify(detail.thread)).toContain('[📷 evil.png]');
    expect(JSON.stringify(detail)).not.toContain(SECRET_B64);
  });
});

describe('copilot compaction markers', () => {
  it('counts only the `compaction` reason and stamps the turn that follows it', async () => {
    const detail = (await get('/api/sessions/copilot-sess-1')).json();
    expect(detail.meta.compactionCount).toBe(1); // the model_change reason is not one

    const stamped = detail.thread.filter((t: { compaction?: unknown }) => t.compaction);
    expect(stamped).toHaveLength(1);
    expect(JSON.stringify(stamped[0].blocks)).toContain('carry on from the summary');
    // Copilot records neither a trigger nor a summary on the marker, and its
    // usage is a session total pinned to the last turn — not a prompt size —
    // so no before/after figure may be derived from it either.
    expect(stamped[0].compaction).toEqual({});
  });

  it('reports the compaction count but no context size (session-level usage)', async () => {
    const { meta } = (await get('/api/sessions/copilot-sess-1')).json();
    expect(meta.compactionCount).toBe(1);
    expect(meta.contextTokens).toBeUndefined();
    expect(meta.contextWindow).toBeUndefined();
  });

  it('keeps a subagent compaction in its own run and out of the session count', async () => {
    const detail = (await get('/api/sessions/copilot-sess-3')).json();
    // Main thread only: the run compacted, the session did not.
    expect(detail.meta.compactionCount).toBe(0);
    expect(detail.thread.some((t: { compaction?: unknown }) => t.compaction)).toBe(false);

    const run = detail.subagents.find((r: { agentType: string }) => r.agentType === 'explore');
    const stamped = run.thread.filter((t: { compaction?: unknown }) => t.compaction);
    expect(stamped).toHaveLength(1);
    expect(JSON.stringify(stamped[0].blocks)).toContain('resumed the zebrafinder scan');
  });
});
