/**
 * Codex connector integration test.
 *
 * Builds the index from a synthetic Codex `rollout-*.jsonl` (in an isolated temp
 * `CODEX_SESSIONS_DIR`, with the Claude source empty) and exercises the routes,
 * verifying the cross-line normalization: session id/cwd from session_meta, model
 * from turn_context, per-turn tokens from token_count, and the response_item
 * transcript (message / reasoning / function_call ↔ function_call_output).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const work = mkdtempSync(join(tmpdir(), 'claudescope-codex-'));
const codexDir = join(work, 'codex');
const claudeDir = join(work, 'claude-empty');

process.env.CLAUDE_PROJECTS_DIR = claudeDir;
process.env.CODEX_SESSIONS_DIR = codexDir;
// Isolate from the real ~/.junie and ~/.pi so this Codex-only suite stays deterministic.
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
const ts = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;

/** Write one synthetic rollout under codex/YYYY/MM/DD/. */
function writeRollout(): string {
  const dir = join(codexDir, '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-01T10-00-00-019db3da-f840-7142-a548-5bd30f5fe572.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(0), payload: { id: 'codex-sess-1', cwd: '/tmp/codexproj', cli_version: '0.122.0', model_provider: 'openai', git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(1), payload: { model: 'gpt-5.4', cwd: '/tmp/codexproj' } },
      // developer (system) message — must be dropped from the transcript.
      { type: 'response_item', timestamp: ts(1), payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system instructions' }] } },
      { type: 'response_item', timestamp: ts(2), payload: { type: 'message', role: 'user', content: [
        // Codex stores a pasted image as an input_image (base64 data URL) plus a
        // redundant `<image …>` placeholder text item that must be dropped.
        { type: 'input_text', text: '<image name=[Image #1] path="/var/tmp/codex-clipboard-xyz.png">' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANS' },
        { type: 'input_text', text: 'find the needle in this codex haystack' },
      ] } },
      { type: 'response_item', timestamp: ts(3), payload: { type: 'reasoning', summary: [], content: null, encrypted_content: 'enc-abc' } },
      { type: 'response_item', timestamp: ts(4), payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls -la"}', call_id: 'call_1' } },
      { type: 'response_item', timestamp: ts(5), payload: { type: 'function_call_output', call_id: 'call_1', output: 'file.txt\n' } },
      // Older-CLI `shell` form: command is an argv array → joined for display, with
      // a space-bearing element quoted so the boundary survives.
      { type: 'response_item', timestamp: ts(6), payload: { type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","echo hi there"]}', call_id: 'call_2' } },
      { type: 'response_item', timestamp: ts(7), payload: { type: 'function_call_output', call_id: 'call_2', output: 'hi there\n' } },
      // A file read via the shell, wrapped in Codex's exec envelope — stripped down
      // to just the stdout so the UI can highlight it like a file view.
      { type: 'response_item', timestamp: ts(8), payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat src/Foo.cs"}', call_id: 'call_3' } },
      { type: 'response_item', timestamp: ts(9), payload: { type: 'function_call_output', call_id: 'call_3', output: 'Chunk ID: a894d2\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 84\nOutput:\nusing System;\n\npublic class Foo { }\n' } },
      // Malformed arguments on a shell tool: no command can be recovered, so the
      // block stays under its raw name (payload preserved) — NOT an empty Bash block.
      { type: 'response_item', timestamp: ts(10), payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls', call_id: 'call_4' } },
      { type: 'response_item', timestamp: ts(11), payload: { type: 'function_call_output', call_id: 'call_4', output: 'oops\n' } },
      { type: 'response_item', timestamp: ts(12), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'found it' }] } },
      { type: 'event_msg', timestamp: ts(13), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 300, reasoning_output_tokens: 50, total_tokens: 1300 } }, rate_limits: {} } },
      // ToolSearch-style deferred-tool discovery: call + output pair by call_id.
      { type: 'response_item', timestamp: ts(14), payload: { type: 'tool_search_call', call_id: 'call_ts1', status: 'completed', arguments: { query: 'spawn subagent', limit: 8 } } },
      { type: 'response_item', timestamp: ts(15), payload: { type: 'tool_search_output', call_id: 'call_ts1', status: 'completed', tools: [{ type: 'namespace', name: 'multi_agent_v1' }] } },
      // spawn_agent → canonical Task; the output names the child thread id that the
      // child rollout's session_meta carries as its own id.
      { type: 'response_item', timestamp: ts(16), payload: { type: 'function_call', name: 'spawn_agent', arguments: '{"agent_type":"explorer","message":"Scan the repo for issues.\\nReport back concisely."}', call_id: 'call_spawn1' } },
      { type: 'response_item', timestamp: ts(17), payload: { type: 'function_call_output', call_id: 'call_spawn1', output: '{"agent_id":"019f2222-aaaa-7bbb-8ccc-000000000001","nickname":"Linnaeus"}' } },
      // wait_agent stays under its raw name (payload visible, no Task synthesized).
      { type: 'response_item', timestamp: ts(18), payload: { type: 'function_call', name: 'wait_agent', arguments: '{"targets":["019f2222-aaaa-7bbb-8ccc-000000000001"]}', call_id: 'call_wait1' } },
      { type: 'response_item', timestamp: ts(19), payload: { type: 'function_call_output', call_id: 'call_wait1', output: '{"status":{"019f2222-aaaa-7bbb-8ccc-000000000001":{"completed":"done"}}}' } },
      // apply_patch (custom_tool_call: input is the raw V4A patch string) touching
      // two files → fans out to one canonical block per file with #i suffixed ids.
      { type: 'response_item', timestamp: ts(20), payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_ap1', input: '*** Begin Patch\n*** Add File: /tmp/codexproj/notes.md\n+hello\n+world\n*** Update File: /tmp/codexproj/src/app.ts\n@@\n context line\n-old value\n+new value\n*** End Patch' } },
      { type: 'response_item', timestamp: ts(21), payload: { type: 'custom_tool_call_output', call_id: 'call_ap1', output: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nA /tmp/codexproj/notes.md\nM /tmp/codexproj/src/app.ts' } },
      // Single-file patch: block keeps the bare call_id and the result is the
      // envelope-stripped tool output.
      { type: 'response_item', timestamp: ts(22), payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_ap2', input: '*** Begin Patch\n*** Update File: /tmp/codexproj/single.ts\n@@\n-a\n+b\n*** End Patch' } },
      { type: 'response_item', timestamp: ts(23), payload: { type: 'custom_tool_call_output', call_id: 'call_ap2', output: 'Exit code: 0\nWall time: 0.0 seconds\nOutput:\nSuccess. Updated the following files:\nM /tmp/codexproj/single.ts' } },
      // web_search_call has no call_id and no paired output record.
      { type: 'response_item', timestamp: ts(24), payload: { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'codex docs' } } },
      // A REJECTED two-file patch (non-zero exit): nothing on disk changed, so the
      // fanned canonical blocks must demote back to raw apply_patch (no file_path)
      // and the real error text must survive on every result.
      { type: 'response_item', timestamp: ts(25), payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_ap3', input: '*** Begin Patch\n*** Update File: /tmp/codexproj/missing.ts\n@@\n-x\n+y\n*** Update File: /tmp/codexproj/other.ts\n@@\n-p\n+q\n*** End Patch' } },
      { type: 'response_item', timestamp: ts(26), payload: { type: 'custom_tool_call_output', call_id: 'call_ap3', output: 'Exit code: 1\nWall time: 0.0 seconds\nOutput:\napply_patch: /tmp/codexproj/missing.ts: No such file or directory' } },
    ]),
  );
  return file;
}

/** A subagent rollout: separate file, re-keyed under the parent via thread_spawn. */
function writeChildRollout(): string {
  const dir = join(codexDir, '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-01T10-01-00-019f2222-aaaa-7bbb-8ccc-000000000001.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(30), payload: { id: '019f2222-aaaa-7bbb-8ccc-000000000001', cwd: '/tmp/codexproj', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'codex-sess-1', depth: 1, agent_nickname: 'Linnaeus', agent_role: 'explorer' } } }, git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(31), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(32), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Scan the repo for issues.' }] } },
      { type: 'response_item', timestamp: ts(33), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'zebranugget report from the child' }] } },
      // Child usage folds into the parent session's totals (claude-code precedent).
      { type: 'event_msg', timestamp: ts(34), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 } }, rate_limits: {} } },
    ]),
  );
  return file;
}

/** A subagent rollout whose parent rollout does not exist: it indexes under the
 *  (absent) root id and `loadSession` promotes its events to the main thread. */
function writeOrphanRollout(): string {
  const dir = join(codexDir, '2026', '01', '02');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-02T09-00-00-019f3333-aaaa-7bbb-8ccc-000000000002.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(40), payload: { id: '019f3333-aaaa-7bbb-8ccc-000000000002', cwd: '/tmp/codexproj', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'codex-gone', depth: 1, agent_nickname: 'Orphan', agent_role: 'explorer' } } } } },
      { type: 'turn_context', timestamp: ts(41), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(42), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'orphan probe text' }] } },
      { type: 'response_item', timestamp: ts(43), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'orphan done' }] } },
    ]),
  );
  return file;
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(claudeDir, { recursive: true });
  writeRollout();
  writeChildRollout();
  writeOrphanRollout();

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

describe('Codex session indexing', () => {
  it('lists the Codex session with model from turn_context and a codex agent tag', async () => {
    const sessions = (await get('/api/sessions')).json();
    // The child rollout folds into its parent (never its own session); the orphan
    // child indexes under its absent root id `codex-gone`.
    expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual(['codex-gone', 'codex-sess-1']);
    const main = sessions.find((s: { id: string }) => s.id === 'codex-sess-1');
    expect(main.models).toContain('gpt-5.4');
    expect(main.connectorId).toBe('codex');
    // Codex has no ai-title, so the title falls back to the (cleaned) first user
    // message and is flagged derived so the UI can mark it "from first message".
    expect(main.title).toBe('find the needle in this codex haystack');
    expect(main.titleDerived).toBe(true);
    // The re-keyed subagent rollout flips the parent's sidechain flag.
    expect(main.hasSidechain).toBe(true);
  });

  it('tags the project with its agent and groups analytics by agent', async () => {
    const projects = (await get('/api/projects')).json();
    expect(projects[0].connectorIds).toContain('codex');

    const { rows } = (await get('/api/analytics?groupBy=agent')).json();
    expect(rows.map((r: { key: string }) => r.key)).toContain('codex');
  });

  it('exposes the codex source directory via /api/sources', async () => {
    const sources = (await get('/api/sources')).json();
    expect(sources.some((s: { id: string }) => s.id === 'codex')).toBe(true);
  });

  it('attributes token_count usage (incl. the subagent) and computes a gpt-5.4 cost', async () => {
    const sessions = (await get('/api/sessions')).json();
    const s = sessions.find((x: { id: string }) => x.id === 'codex-sess-1');
    // Parent: input 1000 - cached 200 = 800 input; 200 cache_read; 300 output = 1300.
    // Child rollout usage counts toward the parent session: +100 input +50 output.
    expect(s.totalTokens).toBe(1450);
    // gpt-5.4 @ official cached 0.25: (800*2.5 + 300*15 + 200*0.25) / 1e6 = 0.00655
    // plus the child's (100*2.5 + 50*15) / 1e6 = 0.001 → 0.00755
    expect(s.totalCostUsd).toBeCloseTo(0.00755, 5);
  });

  it('groups analytics by the OpenAI model', async () => {
    const { rows } = (await get('/api/analytics?groupBy=model')).json();
    expect(rows.map((r: { key: string }) => r.key)).toContain('gpt-5.4');
  });

  it('finds the Codex session via full-text search', async () => {
    const { sessions: results } = (await get('/api/search?q=needle')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === 'codex-sess-1')).toBe(true);
  });

  it('surfaces subagent text under the PARENT session in search', async () => {
    const { sessions: results } = (await get('/api/search?q=zebranugget')).json();
    const ids = results.map((r: { sessionId: string }) => r.sessionId);
    expect(ids).toContain('codex-sess-1');
    expect(ids).not.toContain('019f2222-aaaa-7bbb-8ccc-000000000001');
  });
});

describe('Codex session detail', () => {
  it('normalizes response_items into a thread with paired tool call/result', async () => {
    const detail = (await get('/api/sessions/codex-sess-1')).json();

    // assembleThread pairs tool_use+tool_result into a `kind:'tool'` block and
    // folds the result-only user turn away.
    const flat = detail.thread.flatMap(
      (t: { blocks: Record<string, unknown>[] }) => t.blocks,
    );
    expect(flat.some((b: Record<string, unknown>) => b.type === 'thinking')).toBe(true);

    // Codex's shell tool (`exec_command`, arg `cmd`) is canonicalized to `Bash`
    // with the command under `input.command`, so the web renderer highlights it
    // as bash instead of dumping the raw JSON args. (Other Codex tools pass
    // through under their raw name.)
    const tool = flat.find((b: Record<string, unknown>) => b.kind === 'tool');
    expect(tool).toMatchObject({ name: 'Bash', id: 'call_1' });
    expect((tool.input as { command: string }).command).toBe('ls -la');
    expect(tool.result).toBeTruthy(); // function_call_output paired in

    // Older `shell` argv array → single joined command; the space-bearing element
    // is quoted so the argv boundary isn't lost.
    const shellTool = flat.find((b: Record<string, unknown>) => b.id === 'call_2');
    expect(shellTool.name).toBe('Bash');
    expect((shellTool.input as { command: string }).command).toBe('bash -lc "echo hi there"');

    // The exec envelope is stripped to just the stdout (so it can highlight as a file).
    const readTool = flat.find((b: Record<string, unknown>) => b.id === 'call_3');
    expect((readTool.input as { command: string }).command).toBe('cat src/Foo.cs');
    const readOut = readTool.result.content[0].text as string;
    expect(readOut).toContain('using System;');
    expect(readOut).not.toContain('Chunk ID'); // envelope removed

    // Malformed shell args: stays raw (payload visible), never an empty Bash block.
    const badTool = flat.find((b: Record<string, unknown>) => b.id === 'call_4');
    expect(badTool.name).toBe('exec_command');
    expect(JSON.stringify(badTool.input)).toContain('ls');

    // The developer (system) message must not appear as a turn.
    const allText = JSON.stringify(detail.thread);
    expect(allText).not.toContain('system instructions');
    expect(allText).toContain('found it');

    // The pasted image becomes a renderable image block (surfaced as an
    // attachment), and its `<image …>` placeholder text is stripped.
    const img = flat.find(
      (b: Record<string, unknown>) =>
        b.kind === 'attachment' &&
        (b.attachment as { type?: string })?.type === 'image',
    );
    expect(img).toBeTruthy();
    expect((img.attachment as { source: { url: string } }).source.url).toMatch(/^data:image\/png;base64,/);
    expect(allText).not.toContain('codex-clipboard'); // placeholder path dropped
  });

  it('nests the subagent rollout at the spawn_agent → Task call', async () => {
    const detail = (await get('/api/sessions/codex-sess-1')).json();
    const flat = detail.thread.flatMap(
      (t: { blocks: Record<string, unknown>[] }) => t.blocks,
    );

    // spawn_agent is canonicalized to a Task block whose description is the first
    // line of the prompt — the correlation key the nested run anchors to.
    const task = flat.find((b: Record<string, unknown>) => b.name === 'Task');
    expect(task).toMatchObject({ id: 'call_spawn1' });
    expect(task.input).toMatchObject({
      description: 'Scan the repo for issues.',
      subagent_type: 'explorer',
    });

    expect(detail.subagents).toHaveLength(1);
    const run = detail.subagents[0];
    expect(run).toMatchObject({
      agentId: '019f2222-aaaa-7bbb-8ccc-000000000001',
      agentType: 'explorer',
      description: 'Scan the repo for issues.',
      toolUseId: 'call_spawn1', // anchored to the Task block
    });
    expect(JSON.stringify(run.thread)).toContain('zebranugget');
    // The subagent's turns must NOT be inlined into the main thread.
    expect(JSON.stringify(detail.thread)).not.toContain('zebranugget');

    // wait_agent is not a spawn — it stays under its raw name.
    const wait = flat.find((b: Record<string, unknown>) => b.id === 'call_wait1');
    expect(wait.name).toBe('wait_agent');
  });

  it('fans apply_patch out to canonical Write/Edit blocks the changeset keys off', async () => {
    const detail = (await get('/api/sessions/codex-sess-1')).json();
    const flat = detail.thread.flatMap(
      (t: { blocks: Record<string, unknown>[] }) => t.blocks,
    );

    // Two-file patch → one canonical block per file, ids suffixed with #i.
    const write = flat.find((b: Record<string, unknown>) => b.id === 'call_ap1#0');
    expect(write).toMatchObject({ name: 'Write' });
    expect(write.input).toEqual({ file_path: '/tmp/codexproj/notes.md', content: 'hello\nworld' });
    expect(write.result.content[0].text).toBe('Created /tmp/codexproj/notes.md');

    const edit = flat.find((b: Record<string, unknown>) => b.id === 'call_ap1#1');
    expect(edit).toMatchObject({ name: 'MultiEdit' });
    expect(edit.input).toEqual({
      file_path: '/tmp/codexproj/src/app.ts',
      edits: [{ old_string: 'context line\nold value', new_string: 'context line\nnew value' }],
    });

    // Single-file patch keeps the bare call_id and the envelope-stripped output.
    const single = flat.find((b: Record<string, unknown>) => b.id === 'call_ap2');
    expect(single).toMatchObject({ name: 'MultiEdit' });
    const out = single.result.content[0].text as string;
    expect(out).toContain('Success. Updated');
    expect(out).not.toContain('Exit code');

    // tool_search / web_search render as tool blocks instead of vanishing.
    const search = flat.find((b: Record<string, unknown>) => b.id === 'call_ts1');
    expect(search).toMatchObject({ name: 'tool_search' });
    expect(search.result).toBeTruthy();
    const web = flat.find((b: Record<string, unknown>) => b.name === 'web_search');
    expect((web.input as { query: string }).query).toBe('codex docs');
  });

  it('demotes a REJECTED apply_patch to raw blocks so Files-changed never sees it', async () => {
    const detail = (await get('/api/sessions/codex-sess-1')).json();
    const flat = detail.thread.flatMap(
      (t: { blocks: Record<string, unknown>[] }) => t.blocks,
    );

    const failed = flat.filter(
      (b: Record<string, unknown>) => b.id === 'call_ap3#0' || b.id === 'call_ap3#1',
    );
    expect(failed).toHaveLength(2);
    for (const b of failed) {
      // Demoted: raw name and no file_path, so changeset.ts never lists the
      // untouched files (the failed-edit convention the copilot connector set).
      expect(b.name).toBe('apply_patch');
      expect((b.input as { file_path?: string }).file_path).toBeUndefined();
      // The real error output survives on every fanned result, envelope intact.
      const out = b.result.content[0].text as string;
      expect(out).toContain('Exit code: 1');
      expect(out).toContain('No such file or directory');
    }
    // No canonical block may reference the rejected patch's files.
    const canonical = flat.filter((b: Record<string, unknown>) =>
      ['Write', 'Edit', 'MultiEdit'].includes(b.name as string),
    );
    for (const b of canonical) {
      expect((b.input as { file_path: string }).file_path).not.toContain('missing.ts');
      expect((b.input as { file_path: string }).file_path).not.toContain('other.ts');
    }
  });

  it('promotes an orphaned subagent (missing parent rollout) to the main thread', async () => {
    const detail = (await get('/api/sessions/codex-gone')).json();
    expect(detail.subagents).toEqual([]);
    const allText = JSON.stringify(detail.thread);
    expect(allText).toContain('orphan probe text');
    expect(allText).toContain('orphan done');
  });
});
