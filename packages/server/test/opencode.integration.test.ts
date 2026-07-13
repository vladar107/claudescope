/**
 * opencode connector integration test.
 *
 * Builds a synthetic opencode SQLite DB (session/message/part) in a temp dir,
 * indexes it, and exercises the routes — verifying the SQLite-sourced path: a
 * session becomes one synthetic file, per-message tokens (reasoning folded into
 * output) cost as `gpt-5.4-mini-fast`, plaintext reasoning renders, `apply_patch`
 * fans out to canonical `MultiEdit`/`Write` (Files-changed tab), `read`→`Read`,
 * and a pasted screenshot (`file` part, data URL) embeds. Task-spawned child
 * sessions (`parent_id`) fold into the parent as embedded subagents anchored to
 * their canonical `Task` block; dangling and cyclic parent links degrade to
 * standalone sessions instead of hanging or crashing.
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
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
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
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  const ses = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?)');
  ses.run('ses_test1', '/tmp/ocproj', 'Test session', null, 1000, 3000);
  // task-spawned child — must fold into ses_test1, its title must NOT clobber the parent's.
  ses.run('ses_child1', '/tmp/ocproj', 'Inspect entry point (@explore subagent)', 'ses_test1', 2500, 2900);
  // degraded parent links: a dangling parent_id and a two-session cycle. All three
  // must index as standalone sessions — no re-keying, no hang, no crash.
  ses.run('ses_dangling', '/tmp/ocproj', 'Dangling child', 'ses_ghost', 4000, 4100);
  ses.run('ses_cyc1', '/tmp/ocproj', 'Cycle one', 'ses_cyc2', 5000, 5100);
  ses.run('ses_cyc2', '/tmp/ocproj', 'Cycle two', 'ses_cyc1', 5000, 5100);

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

  // Parent turn that spawns the subagent: a `task` part whose metadata.sessionId
  // names the child — the connector maps it to a canonical `Task` block.
  msg.run('a2', 'ses_test1', 2500, 2500, JSON.stringify({
    role: 'assistant', modelID: 'gpt-5.4-mini-fast', providerID: 'openai', time: { created: 2500 },
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
  }));
  part.run('p8', 'a2', 'ses_test1', 2501, 2501, JSON.stringify({
    type: 'tool', tool: 'task', callID: 'call_t',
    state: {
      status: 'completed',
      input: {
        description: 'Inspect entry point',
        prompt: 'Find the app entry point and report it.',
        subagent_type: 'explore', task_id: '', command: 'inspect the codebase entry point',
      },
      output: 'Entry point is packages/server/src/index.ts',
      metadata: {
        sessionId: 'ses_child1', parentSessionId: 'ses_test1',
        model: { modelID: 'gpt-5.4-mini-fast', providerID: 'openai' },
      },
    },
  }));

  // Child transcript — tokens must fold into the parent's totals.
  msg.run('cu1', 'ses_child1', 2600, 2600, JSON.stringify({ role: 'user', time: { created: 2600 } }));
  part.run('cp1', 'cu1', 'ses_child1', 2601, 2601, JSON.stringify({ type: 'text', text: 'Find the app entry point and report it.' }));
  msg.run('ca1', 'ses_child1', 2700, 2700, JSON.stringify({
    role: 'assistant', modelID: 'gpt-5.4-mini-fast', providerID: 'openai', time: { created: 2700 },
    tokens: { total: 110, input: 100, output: 10, reasoning: 0, cache: { write: 0, read: 0 } },
  }));
  part.run('cp2', 'ca1', 'ses_child1', 2701, 2701, JSON.stringify({
    type: 'text', text: 'The xylophone entry point is packages/server/src/index.ts',
  }));

  // Degraded sessions need at least one event row to materialize in the index.
  msg.run('du1', 'ses_dangling', 4000, 4000, JSON.stringify({ role: 'user', time: { created: 4000 } }));
  part.run('dp1', 'du1', 'ses_dangling', 4001, 4001, JSON.stringify({ type: 'text', text: 'orphaned child prompt' }));
  msg.run('y1u', 'ses_cyc1', 5000, 5000, JSON.stringify({ role: 'user', time: { created: 5000 } }));
  part.run('y1p', 'y1u', 'ses_cyc1', 5001, 5001, JSON.stringify({ type: 'text', text: 'cycle one prompt' }));
  msg.run('y2u', 'ses_cyc2', 5000, 5000, JSON.stringify({ role: 'user', time: { created: 5000 } }));
  part.run('y2p', 'y2u', 'ses_cyc2', 5001, 5001, JSON.stringify({ type: 'text', text: 'cycle two prompt' }));
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
  it('lists the SQLite-sourced sessions; task children fold, degraded links stay standalone', async () => {
    const sessions = (await get('/api/sessions')).json();
    // ses_child1 must NOT be listed (re-keyed under ses_test1); the dangling and
    // cyclic parent links must degrade to standalone sessions, not hang or vanish.
    expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual([
      'ses_cyc1', 'ses_cyc2', 'ses_dangling', 'ses_test1',
    ]);
    const parent = sessions.find((s: { id: string }) => s.id === 'ses_test1');
    expect(parent.connectorId).toBe('opencode');
    expect(parent.models).toContain('gpt-5.4-mini-fast');
    // stored title, not first-message fallback — and not the CHILD's title, which
    // shares the parent's session_id in the titles projection.
    expect(parent.title).toBe('Test session');
    expect(parent.hasSidechain).toBe(true);
  });

  it('tags the project, exposes the source, and groups analytics by agent/model', async () => {
    expect((await get('/api/projects')).json()[0].connectorIds).toContain('opencode');
    expect((await get('/api/sources')).json().some((s: { id: string }) => s.id === 'opencode')).toBe(true);
    const byAgent = (await get('/api/analytics?groupBy=agent')).json().rows.map((r: { key: string }) => r.key);
    expect(byAgent).toContain('opencode');
    const byModel = (await get('/api/analytics?groupBy=model')).json().rows.map((r: { key: string }) => r.key);
    expect(byModel).toContain('gpt-5.4-mini-fast');
  });

  it('folds reasoning into output, prices gpt-5.4-mini-fast, and counts child tokens', async () => {
    const sessions = (await get('/api/sessions')).json();
    const s = sessions.find((x: { id: string }) => x.id === 'ses_test1');
    // main: input 1000 + output(50)+reasoning(200)=250 + cacheRead 300 = 1550;
    // child (folded in): input 100 + output 10 = 110. Total 1660.
    expect(s.totalTokens).toBe(1660);
    // (1000*0.75 + 250*4.5 + 300*0.075 + 100*0.75 + 10*4.5) / 1e6 = 0.0020175.
    expect(s.totalCostUsd).toBeCloseTo(0.0020175, 6);
  });

  it('exposes the per-message provider without flagging a non-local one', async () => {
    const s = (await get('/api/sessions')).json().find((x: { id: string }) => x.id === 'ses_test1');
    // Every assistant message carries providerID 'openai' (incl. the folded child).
    expect(s.providers).toEqual(['openai']);
    // 'openai' isn't in the pricing `providers` table → not a local/zero-rated one.
    expect(s.hasLocalProvider).toBeFalsy();
  });

  it('finds the session via full-text search, including subagent text under the parent', async () => {
    const { sessions: results } = (await get('/api/search?q=patched')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === 'ses_test1')).toBe(true);
    // text from the child transcript surfaces under the PARENT session id.
    const { sessions: sub } = (await get('/api/search?q=xylophone')).json();
    expect(sub.some((r: { sessionId: string }) => r.sessionId === 'ses_test1')).toBe(true);
    expect(sub.every((r: { sessionId: string }) => r.sessionId !== 'ses_child1')).toBe(true);
  });
});

describe('opencode session detail', () => {
  it('renders reasoning, apply_patch→canonical edits, read, and the screenshot', async () => {
    const detail = (await get('/api/sessions/ses_test1')).json();
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

  it('embeds the task-spawned child as a subagent anchored to its Task block', async () => {
    const detail = (await get('/api/sessions/ses_test1')).json();
    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);

    // the `task` part becomes a canonical Task block in the parent thread.
    const task = flat.find((b: Record<string, unknown>) => b.kind === 'tool' && b.name === 'Task');
    expect(task.input).toMatchObject({ description: 'Inspect entry point', subagent_type: 'explore' });

    // the child session rides in as a SubagentRun anchored to that block.
    expect(detail.subagents).toHaveLength(1);
    const run = detail.subagents[0];
    expect(run).toMatchObject({
      agentId: 'ses_child1',
      agentType: 'explore',
      description: 'Inspect entry point',
    });
    expect(run.toolUseId).toBe(task.id);
    // the child's own turns render inside the run, not in the main thread.
    expect(JSON.stringify(run.thread)).toContain('xylophone');
    expect(JSON.stringify(detail.thread)).not.toContain('xylophone');
  });

  it('serves a degraded (dangling-parent) child as its own session', async () => {
    const detail = (await get('/api/sessions/ses_dangling')).json();
    expect(detail.subagents).toEqual([]);
    expect(JSON.stringify(detail.thread)).toContain('orphaned child prompt');
  });
});

// Runs last: it writes to the fixture DB (never a real source), and mutating
// `time_updated` rows would perturb the earlier assertions if it ran first.
describe('opencode session fingerprint', () => {
  it('probes synthetic <dbPath>#<id> paths via SQLite and flips on new rows without a reindex', async () => {
    const before = (await get('/api/sessions/ses_test1/fingerprint')).json();
    // A working fingerprint proves the probe never fs.stat'ed the synthetic
    // path (which does not exist on disk) — it asked the DB instead.
    expect(before.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    // max time_updated across the session's synthetic files (parent + folded child).
    expect(before.lastModifiedMs).toBe(3000);

    // A new part row with a later time_updated — the live change signal.
    const db = new DatabaseSync(join(ocDataDir, 'opencode.db'));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(
      'p_live', 'a1', 'ses_test1', 9999, 9999,
      JSON.stringify({ type: 'text', text: 'streamed in later' }),
    );
    db.close();

    const after = (await get('/api/sessions/ses_test1/fingerprint')).json();
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.lastModifiedMs).toBe(9999);
  });
});
