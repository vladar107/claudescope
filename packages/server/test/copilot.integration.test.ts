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
 *   - global memory read from `~/.copilot/copilot-instructions.md`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ts = (s: number) => `2026-06-16T10:00:${String(s).padStart(2, '0')}.000Z`;
let evtId = 0;
/** Wrap a `{type, data}` pair into a Copilot event envelope. */
const ev = (type: string, data: unknown) => ({ type, data, id: `e${evtId++}`, timestamp: ts(evtId), parentId: null });

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
      // Unknown event type — must be tolerated and skipped without breaking indexing.
      ev('session.context_changed', { reason: 'compaction' }),
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

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  writeSession1();
  writeSession2();
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
type Session = { id: string; connectorId: string; title: string; models: string[]; totalTokens: number; totalCostUsd: number };
const sessionById = async (id: string): Promise<Session> =>
  (await get('/api/sessions')).json().find((s: Session) => s.id === id);

describe('copilot session indexing', () => {
  it('lists both sessions tagged copilot, with model and workspace.yaml title', async () => {
    const sessions: Session[] = (await get('/api/sessions')).json();
    expect(sessions.map((s) => s.id).sort()).toEqual(['copilot-sess-1', 'copilot-sess-2']);
    for (const s of sessions) {
      expect(s.connectorId).toBe('copilot');
      expect(s.models).toContain('gpt-5-mini');
    }
    expect((await sessionById('copilot-sess-1')).title).toBe('Fix the bug');
    expect((await sessionById('copilot-sess-2')).title).toBe('Audit the project');
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
