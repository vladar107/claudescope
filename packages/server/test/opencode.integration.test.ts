/**
 * opencode connector integration test.
 *
 * Builds a synthetic opencode SQLite DB (session/message/part) in a temp dir,
 * indexes it, and exercises the routes — verifying the SQLite-sourced path: a
 * session becomes one synthetic file, per-message tokens (reasoning folded into
 * output) cost as `gpt-5.4-mini-fast`, plaintext reasoning renders, `apply_patch`
 * fans out to canonical `MultiEdit`/`Write` (Files-changed tab), `read`→`Read`,
 * and a pasted screenshot (`file` part, data URL) embeds.
 *
 * Never touches the real `~/.local/share/opencode`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const work = mkdtempSync(join(tmpdir(), 'claudescope-opencode-'));
const ocDataDir = join(work, 'opencode');
const claudeDir = join(work, 'claude-empty');

process.env.CLAUDE_PROJECTS_DIR = claudeDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = ocDataDir;
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

// 1x1 transparent PNG — stands in for a pasted clipboard screenshot.
const PNG_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const UPDATE_PATCH = [
  'Index: /tmp/ocproj/a.txt',
  '===================================================================',
  '--- /tmp/ocproj/a.txt',
  '+++ /tmp/ocproj/a.txt',
  '@@ -1,2 +1,2 @@',
  ' keep this line',
  '-old line',
  '+new line',
].join('\n');

const ADD_PATCH = [
  'Index: /tmp/ocproj/new.txt',
  '===================================================================',
  '--- /tmp/ocproj/new.txt',
  '+++ /tmp/ocproj/new.txt',
  '@@ -0,0 +1,1 @@',
  '+hello world',
].join('\n');

/** Build a minimal but realistic opencode.db (only the columns the connector reads). */
function writeDb(): void {
  mkdirSync(ocDataDir, { recursive: true });
  const db = new DatabaseSync(join(ocDataDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run(
    'ses_test1', '/tmp/ocproj', 'Test session', 1000, 3000,
  );

  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  msg.run('u1', 'ses_test1', 1000, 1000, JSON.stringify({ role: 'user', time: { created: 1000 } }));
  msg.run('a1', 'ses_test1', 2000, 2000, JSON.stringify({
    role: 'assistant', modelID: 'gpt-5.4-mini-fast', providerID: 'openai', time: { created: 2000 },
    tokens: { total: 1550, input: 1000, output: 50, reasoning: 200, cache: { write: 0, read: 300 } },
  }));

  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)');
  // user parts: prompt text + a pasted screenshot file part
  part.run('p1', 'u1', 'ses_test1', 1001, 1001, JSON.stringify({ type: 'text', text: 'inspect and patch /tmp/ocproj — see screenshot' }));
  part.run('p2', 'u1', 'ses_test1', 1002, 1002, JSON.stringify({ type: 'file', mime: 'image/png', filename: 'clipboard', url: PNG_URL }));
  // assistant parts: reasoning + text + apply_patch (2 files) + read + step-finish
  part.run('p3', 'a1', 'ses_test1', 2001, 2001, JSON.stringify({ type: 'reasoning', text: 'I will patch a.txt and add new.txt' }));
  part.run('p4', 'a1', 'ses_test1', 2002, 2002, JSON.stringify({ type: 'text', text: 'Done — patched and read.' }));
  part.run('p5', 'a1', 'ses_test1', 2003, 2003, JSON.stringify({
    type: 'tool', tool: 'apply_patch', callID: 'call_p',
    state: {
      status: 'completed', input: { patchText: '*** Begin Patch\n…\n*** End Patch' },
      // The shared multi-file summary must NOT end up duplicated on each block.
      output: 'Success. Updated the following files:\nM a.txt\nA new.txt',
      metadata: {
        files: [
          { filePath: '/tmp/ocproj/a.txt', relativePath: 'a.txt', type: 'update', patch: UPDATE_PATCH },
          { filePath: '/tmp/ocproj/new.txt', relativePath: 'new.txt', type: 'add', patch: ADD_PATCH },
        ],
      },
    },
  }));
  part.run('p6', 'a1', 'ses_test1', 2004, 2004, JSON.stringify({
    type: 'tool', tool: 'read', callID: 'call_r',
    state: {
      status: 'completed', input: { filePath: '/tmp/ocproj/a.txt', offset: 1, limit: 10 },
      // opencode wraps read output in <path>/<type>/<content> + line numbers.
      output: '<path>/tmp/ocproj/a.txt</path>\n<type>file</type>\n<content>\n1: keep this line\n2: new line\n</content>\n\n(End of file - total 2 lines)',
    },
  }));
  part.run('p7', 'a1', 'ses_test1', 2005, 2005, JSON.stringify({
    type: 'step-finish', tokens: { total: 1550, input: 1000, output: 50, reasoning: 200, cache: { write: 0, read: 300 } }, cost: 0,
  }));
  db.close();
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(claudeDir, { recursive: true });
  writeDb();

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

describe('opencode session indexing', () => {
  it('lists the SQLite-sourced session with its stored title and an opencode tag', async () => {
    const sessions = (await get('/api/sessions')).json();
    expect(sessions.map((s: { id: string }) => s.id)).toEqual(['ses_test1']);
    expect(sessions[0].connectorId).toBe('opencode');
    expect(sessions[0].models).toContain('gpt-5.4-mini-fast');
    expect(sessions[0].title).toBe('Test session'); // stored title, not first-message fallback
  });

  it('tags the project, exposes the source, and groups analytics by agent/model', async () => {
    expect((await get('/api/projects')).json()[0].connectorIds).toContain('opencode');
    expect((await get('/api/sources')).json().some((s: { id: string }) => s.id === 'opencode')).toBe(true);
    const byAgent = (await get('/api/analytics?groupBy=agent')).json().rows.map((r: { key: string }) => r.key);
    expect(byAgent).toContain('opencode');
    const byModel = (await get('/api/analytics?groupBy=model')).json().rows.map((r: { key: string }) => r.key);
    expect(byModel).toContain('gpt-5.4-mini-fast');
  });

  it('folds reasoning into output and prices gpt-5.4-mini-fast', async () => {
    const s = (await get('/api/sessions')).json()[0];
    // input 1000 + output(50)+reasoning(200)=250 + cacheRead 300 + cacheWrite 0 = 1550.
    expect(s.totalTokens).toBe(1550);
    // (1000*0.75 + 250*4.5 + 300*0.075) / 1e6 = 0.0018975.
    expect(s.totalCostUsd).toBeCloseTo(0.0018975, 6);
  });

  it('finds the session via full-text search', async () => {
    const { sessions: results } = (await get('/api/search?q=patched')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === 'ses_test1')).toBe(true);
  });
});

describe('opencode session detail', () => {
  it('renders reasoning, apply_patch→canonical edits, read, and the screenshot', async () => {
    const detail = (await get('/api/sessions/ses_test1')).json();
    expect(detail.subagents).toEqual([]);
    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);

    // plaintext reasoning survives.
    const thinking = flat.find((b: Record<string, unknown>) => b.type === 'thinking');
    expect(thinking?.thinking).toContain('I will patch');

    // apply_patch → one canonical block per file: Update→MultiEdit, Add→Write.
    const tools = flat.filter((b: Record<string, unknown>) => b.kind === 'tool');
    const multi = tools.find((t: { name: string }) => t.name === 'MultiEdit');
    expect(multi.input.file_path).toBe('/tmp/ocproj/a.txt');
    expect(multi.input.edits[0]).toEqual({
      old_string: 'keep this line\nold line',
      new_string: 'keep this line\nnew line',
    });
    const write = tools.find((t: { name: string }) => t.name === 'Write');
    expect(write.input).toMatchObject({ file_path: '/tmp/ocproj/new.txt', content: 'hello world' });

    // apply_patch results are concise PER-FILE, not the repeated shared summary.
    expect(JSON.stringify(multi.result.content)).toContain('Updated a.txt');
    expect(JSON.stringify(write.result.content)).toContain('Created new.txt');
    expect(JSON.stringify(detail.thread)).not.toContain('Success. Updated the following files');

    // read → Read (filePath renamed to file_path); the <path>/<content> wrapper is
    // unwrapped so the result isn't redundant with the header.
    const read = tools.find((t: { name: string }) => t.name === 'Read');
    expect(read.input.file_path).toBe('/tmp/ocproj/a.txt');
    const readResult = JSON.stringify(read.result.content);
    expect(readResult).toContain('keep this line');
    expect(readResult).not.toContain('<path>');
    expect(readResult).not.toContain('<content>');

    // pasted screenshot embeds (file part → image, surfaced as an attachment).
    const img = flat.find(
      (b: Record<string, unknown>) =>
        b.kind === 'attachment' && (b.attachment as { type?: string })?.type === 'image',
    );
    expect((img.attachment as { source: { url: string } }).source.url).toBe(PNG_URL);
  });
});
