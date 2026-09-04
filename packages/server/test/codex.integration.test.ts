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
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ts = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const pathlessBootstrap = [
  '# AGENTS.md instructions',
  '<INSTRUCTIONS>',
  'Follow the repository guide.',
  '</INSTRUCTIONS>',
  '<environment_context>',
  '  <cwd>/tmp/codexproj</cwd>',
  '</environment_context>',
].join('\n');
const execApplyPatch = (patch: string, direct = false): string =>
  direct
    ? `text(await tools.apply_patch(${JSON.stringify(patch)}));`
    : `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch));`;

/** Write one synthetic rollout under codex/YYYY/MM/DD/. */
function writeRollout(): string {
  const dir = join(codexDir, '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-01T10-00-00-019db3da-f840-7142-a548-5bd30f5fe572.jsonl');
  const nestedPatch = '*** Begin Patch\n*** Add File: /tmp/codexproj/wrapped.md\n+wrapped\n*** Update File: /tmp/codexproj/wrapped.ts\n@@\n-old wrapped\n+new wrapped\n*** End Patch';
  const directNestedPatch = '*** Begin Patch\n*** Update File: /tmp/codexproj/direct-wrapped.ts\n@@\n-before\n+after\n*** End Patch';
  const rejectedNestedPatch = '*** Begin Patch\n*** Update File: /tmp/codexproj/rejected-wrapped.ts\n@@\n-before\n+after\n*** End Patch';
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
        { type: 'input_text', text: `${pathlessBootstrap}\nfind the needle in this codex haystack` },
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
      { type: 'response_item', timestamp: ts(23), payload: { type: 'custom_tool_call_output', call_id: 'call_ap2', output: [
        { type: 'input_text', text: 'Exit code: 0\nWall time: 0.0 seconds\nOutput:\n' },
        { type: 'input_text', text: 'Success. Updated the following files:\nM /tmp/codexproj/single.ts' },
      ] } },
      // web_search_call has no call_id and no paired output record.
      { type: 'response_item', timestamp: ts(24), payload: { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'codex docs' } } },
      // A REJECTED two-file patch (non-zero exit): nothing on disk changed, so the
      // fanned canonical blocks must demote back to raw apply_patch (no file_path)
      // and the real error text must survive on every result.
      { type: 'response_item', timestamp: ts(25), payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_ap3', input: '*** Begin Patch\n*** Update File: /tmp/codexproj/missing.ts\n@@\n-x\n+y\n*** Update File: /tmp/codexproj/other.ts\n@@\n-p\n+q\n*** End Patch' } },
      { type: 'response_item', timestamp: ts(26), payload: { type: 'custom_tool_call_output', call_id: 'call_ap3', output: [
        { type: 'input_text', text: 'Exit code: 1\nWall time: 0.0 seconds\nOutput:\n' },
        { type: 'input_text', text: 'apply_patch: /tmp/codexproj/missing.ts: No such file or directory' },
      ] } },
      // Current Codex spawn format: task_name is readable while the message may
      // be opaque; the output's canonical path matches the child's agent_path.
      { type: 'response_item', timestamp: ts(27), payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"agent_type":"context_explorer","fork_turns":"all","message":"encrypted-task-payload","task_name":"locate_analytics_range"}', call_id: 'call_spawn2' } },
      { type: 'response_item', timestamp: ts(28), payload: { type: 'function_call_output', call_id: 'call_spawn2', output: '{"task_name":"/root/locate_analytics_range"}' } },
      // Current custom outputs are arrays of ordered input_text items. An exec
      // result must concatenate them, while an unfamiliar item remains visible.
      { type: 'response_item', timestamp: ts(29), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_current', input: 'const result = await tools.exec_command({ cmd: "pwd" }); text(result.output);' } },
      { type: 'response_item', timestamp: ts(30), payload: { type: 'custom_tool_call_output', call_id: 'call_exec_current', output: [
        { type: 'input_text', text: 'Script completed\nWall time: 0.1 seconds\nOutput:\n' },
        { type: 'input_text', text: '/tmp/codexproj\n' },
      ] } },
      { type: 'response_item', timestamp: ts(31), payload: { type: 'custom_tool_call', name: 'future_tool', call_id: 'call_unknown_output', input: 'opaque input' } },
      { type: 'response_item', timestamp: ts(32), payload: { type: 'custom_tool_call_output', call_id: 'call_unknown_output', output: [{ type: 'future_content', value: 'must-not-vanish' }] } },
      // Current Codex wraps apply_patch in a JavaScript `exec` custom tool. A
      // static const-bound patch and a direct string literal both remain safely
      // recoverable without evaluating the program.
      { type: 'response_item', timestamp: ts(33), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_ap1', input: execApplyPatch(nestedPatch) } },
      { type: 'response_item', timestamp: ts(34), payload: { type: 'custom_tool_call_output', call_id: 'call_exec_ap1', is_error: false, output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'input_text', text: '{}' },
      ] } },
      { type: 'response_item', timestamp: ts(35), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_ap2', input: execApplyPatch(directNestedPatch, true) } },
      { type: 'response_item', timestamp: ts(36), payload: { type: 'custom_tool_call_output', call_id: 'call_exec_ap2', output: [
        { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'input_text', text: '{}' },
      ] } },
      // Failed wrappers demote to raw exec so Files changed never reports them.
      { type: 'response_item', timestamp: ts(37), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_ap3', input: execApplyPatch(rejectedNestedPatch) } },
      { type: 'response_item', timestamp: ts(38), payload: { type: 'custom_tool_call_output', call_id: 'call_exec_ap3', is_error: true, output: [
        { type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' },
        { type: 'input_text', text: 'apply_patch verification failed' },
      ] } },
      // Patch-like text inside a command string, dynamic input, multiple calls,
      // and an unconfirmed live call all fail closed as ordinary exec blocks.
      { type: 'response_item', timestamp: ts(39), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_text_only', input: 'const command = "rg tools.apply_patch(patch) ."; text(await tools.exec_command({ cmd: command }));' } },
      { type: 'response_item', timestamp: ts(40), payload: { type: 'custom_tool_call_output', call_id: 'call_exec_text_only', is_error: false, output: 'Script completed\nWall time 0.1 seconds\nOutput:\nno matches' } },
      { type: 'response_item', timestamp: ts(41), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_dynamic', input: 'const patch = buildPatch(); text(await tools.apply_patch(patch));' } },
      { type: 'response_item', timestamp: ts(42), payload: { type: 'custom_tool_call_output', call_id: 'call_exec_dynamic', is_error: false, output: 'Script completed\nWall time 0.1 seconds\nOutput:\n{}' } },
      { type: 'response_item', timestamp: ts(43), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_multiple', input: `${execApplyPatch(directNestedPatch, true)}\n${execApplyPatch(directNestedPatch, true)}` } },
      { type: 'response_item', timestamp: ts(44), payload: { type: 'custom_tool_call_output', call_id: 'call_exec_multiple', is_error: false, output: 'Script completed\nWall time 0.1 seconds\nOutput:\n{}' } },
      { type: 'response_item', timestamp: ts(45), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_concat', input: `const patch = ${JSON.stringify(directNestedPatch)} + suffix; text(await tools.apply_patch(patch));` } },
      { type: 'response_item', timestamp: ts(46), payload: { type: 'custom_tool_call_output', call_id: 'call_exec_concat', is_error: false, output: 'Script completed\nWall time 0.1 seconds\nOutput:\n{}' } },
      { type: 'response_item', timestamp: ts(47), payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_exec_unconfirmed', input: execApplyPatch(directNestedPatch, true) } },
      { type: 'response_item', timestamp: ts(48), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'waiting for the patch result' }] } },
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
      // This child spawns a child of its own in the LEGACY form: the output names
      // the grandchild thread id, and the readable label exists ONLY here — the
      // root's spawn map knows nothing about it.
      { type: 'response_item', timestamp: ts(33), payload: { type: 'function_call', name: 'spawn_agent', arguments: '{"agent_type":"summarizer","message":"Tally the findings.\\nBe brief."}', call_id: 'call_spawn3' } },
      { type: 'response_item', timestamp: ts(34), payload: { type: 'function_call_output', call_id: 'call_spawn3', output: '{"agent_id":"019f2222-aaaa-7bbb-8ccc-000000000004","nickname":"Tallier"}' } },
      { type: 'response_item', timestamp: ts(35), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'zebranugget report from the child' }] } },
      // Child usage folds into the parent session's totals (claude-code precedent).
      { type: 'event_msg', timestamp: ts(36), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 } }, rate_limits: {} } },
    ]),
  );
  return file;
}

/** A current-format child correlated by canonical agent_path, not its thread id. */
function writeCurrentChildRollout(): string {
  const dir = join(codexDir, '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-01T10-02-00-019f2222-aaaa-7bbb-8ccc-000000000002.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(35), payload: { id: '019f2222-aaaa-7bbb-8ccc-000000000002', cwd: '/tmp/codexproj', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: 'codex-sess-1', depth: 1, agent_path: '/root/locate_analytics_range', agent_nickname: 'Cartographer', agent_role: 'context_explorer' } } }, git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(36), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(37), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'copied parent context, not the task label' }] } },
      // This child spawns a child of its own: the spawn record lives HERE, not in
      // the root rollout, so only a merged spawn map can resolve the grandchild.
      { type: 'response_item', timestamp: ts(38), payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', arguments: '{"agent_type":"summarizer","message":"Summarize what you found.","task_name":"summarize_findings"}', call_id: 'call_spawn4' } },
      { type: 'response_item', timestamp: ts(39), payload: { type: 'function_call_output', call_id: 'call_spawn4', output: '{"task_name":"/root/locate_analytics_range/summarize_findings"}' } },
      { type: 'response_item', timestamp: ts(40), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'current-format child report' }] } },
    ]),
  );
  return file;
}

/** A DEPTH-2 rollout: `parent_thread_id` names the depth-1 child above, and its
 *  `agent_path` extends that child's canonical path. */
function writeGrandchildRollout(): string {
  const dir = join(codexDir, '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-01T10-03-00-019f2222-aaaa-7bbb-8ccc-000000000003.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(41), payload: { id: '019f2222-aaaa-7bbb-8ccc-000000000003', cwd: '/tmp/codexproj', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: '019f2222-aaaa-7bbb-8ccc-000000000002', depth: 2, agent_path: '/root/locate_analytics_range/summarize_findings', agent_nickname: 'Chronicler', agent_role: 'summarizer' } } }, git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(42), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(43), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize what you found.' }] } },
      { type: 'response_item', timestamp: ts(44), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'quokkaline grandchild summary' }] } },
    ]),
  );
  return file;
}

/** A DEPTH-2 rollout under the LEGACY child: it has no `agent_path`, so its
 *  whole identity (label, type, spawning id) comes from a spawn record that
 *  exists only in the depth-1 child's rollout. */
function writeLegacyGrandchildRollout(): string {
  const dir = join(codexDir, '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-01T10-04-00-019f2222-aaaa-7bbb-8ccc-000000000004.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(45), payload: { id: '019f2222-aaaa-7bbb-8ccc-000000000004', cwd: '/tmp/codexproj', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: '019f2222-aaaa-7bbb-8ccc-000000000001', depth: 2, agent_nickname: 'Tallier', agent_role: 'summarizer' } } }, git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(46), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(47), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Tally the findings.' }] } },
      { type: 'response_item', timestamp: ts(48), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'wombatcount tally from the grandchild' }] } },
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

/**
 * A rollout whose `session_meta.model_provider` is a local runtime (`lmstudio`).
 * The provider is session-level, so it stamps every assistant row and zero-rates
 * the whole session via the provider override — even though the model (`gpt-5.4`)
 * has a real rate and both turns carry usage. Prices off the shipped pricing.json.
 */
function writeLocalRollout(): string {
  const dir = join(codexDir, '2026', '01', '03');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-03T09-00-00-019f4444-aaaa-7bbb-8ccc-000000000003.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(50), payload: { id: 'codex-local-1', cwd: '/tmp/codexproj', cli_version: '0.122.0', model_provider: 'lmstudio', git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(51), payload: { model: 'gpt-5.4', cwd: '/tmp/codexproj' } },
      { type: 'response_item', timestamp: ts(52), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run this offline on my machine' }] } },
      { type: 'response_item', timestamp: ts(53), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first local turn' }] } },
      { type: 'event_msg', timestamp: ts(54), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 300 } }, rate_limits: {} } },
      { type: 'response_item', timestamp: ts(55), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second local turn' }] } },
      { type: 'event_msg', timestamp: ts(56), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 100 } }, rate_limits: {} } },
    ]),
  );
  return file;
}

/** A pathless bootstrap-only turn followed by the genuine user prompt. */
function writeBootstrapOnlyRollout(): string {
  const dir = join(codexDir, '2026', '01', '04');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-04T09-00-00-019f5555-aaaa-7bbb-8ccc-000000000004.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(0), payload: { id: 'codex-title-next', cwd: '/tmp/codexproj' } },
      { type: 'turn_context', timestamp: ts(1), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: pathlessBootstrap }] } },
      { type: 'response_item', timestamp: ts(3), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ready' }] } },
      { type: 'response_item', timestamp: ts(4), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'name this session from the genuine prompt' }] } },
      { type: 'response_item', timestamp: ts(5), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    ]),
  );
  return file;
}

/** A malformed bootstrap must pass through instead of swallowing source text. */
function writeMalformedBootstrapRollout(): string {
  const dir = join(codexDir, '2026', '01', '05');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-05T09-00-00-019f6666-aaaa-7bbb-8ccc-000000000005.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(0), payload: { id: 'codex-title-malformed', cwd: '/tmp/codexproj' } },
      { type: 'turn_context', timestamp: ts(1), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n<INSTRUCTIONS>\nKeep this incomplete wrapper visible' }] } },
      { type: 'response_item', timestamp: ts(2), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'acknowledged' }] } },
      { type: 'response_item', timestamp: ts(3), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do not skip to this later prompt' }] } },
    ]),
  );
  return file;
}

/**
 * A rollout with ONE compaction, written the way Codex writes it: the top-level
 * `compacted` record (the marker), plus the encrypted `compaction` response item
 * and the `context_compacted` event, which must leave no trace in the thread.
 */
function writeCompactionRollout(): string {
  const dir = join(codexDir, '2026', '01', '07');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rollout-2026-01-07T09-00-00-019f7777-aaaa-7bbb-8ccc-000000000007.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(0), payload: { id: 'codex-compact-1', cwd: '/tmp/codexproj' } },
      { type: 'turn_context', timestamp: ts(1), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'grind through the long haul' }] } },
      { type: 'response_item', timestamp: ts(3), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'context is filling up' }] } },
      // 120000 - 20000 cached = 100000 input + 20000 cache_read → a 120000 prompt.
      { type: 'event_msg', timestamp: ts(4), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 120000, cached_input_tokens: 20000, output_tokens: 500 } }, rate_limits: {} } },
      { type: 'compacted', timestamp: ts(5), payload: { message: 'squeezed the long haul into this', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'replacement history is not a transcript' }] }], window_number: 1 } },
      { type: 'response_item', timestamp: ts(6), payload: { type: 'compaction', id: 'cmp_leak', encrypted_content: 'COMPACTION_ENCRYPTED_BLOB' } },
      { type: 'event_msg', timestamp: ts(7), payload: { type: 'context_compacted' } },
      { type: 'response_item', timestamp: ts(8), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'carry on from the summary' }] } },
      { type: 'response_item', timestamp: ts(9), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'resumed with room to spare' }] } },
      { type: 'event_msg', timestamp: ts(10), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 9000, cached_input_tokens: 0, output_tokens: 100 } }, rate_limits: {} } },
    ]),
  );
  return file;
}

/** Guardian approval reviews are internal regardless of thread-source generation. */
function writeGuardianRollouts(): void {
  const dir = join(codexDir, '2026', '01', '06');
  mkdirSync(dir, { recursive: true });
  const variants = [
    ['codex-guardian-legacy', 'subagent'],
    ['codex-guardian-current', 'guardian_review'],
  ] as const;
  for (const [id, threadSource] of variants) {
    const file = join(dir, `rollout-2026-01-06T09-00-00-${id}.jsonl`);
    writeFileSync(
      file,
      jsonl([
        { type: 'session_meta', timestamp: ts(0), payload: { id, cwd: '/tmp/codexproj', thread_source: threadSource, source: { subagent: { other: 'guardian' } } } },
        { type: 'response_item', timestamp: ts(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review this command for approval.' }] } },
      ]),
    );
  }
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(claudeDir, { recursive: true });
  writeRollout();
  writeChildRollout();
  writeCurrentChildRollout();
  writeGrandchildRollout();
  writeLegacyGrandchildRollout();
  writeOrphanRollout();
  writeLocalRollout();
  writeBootstrapOnlyRollout();
  writeMalformedBootstrapRollout();
  writeGuardianRollouts();
  writeCompactionRollout();

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
    expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual([
      'codex-compact-1',
      'codex-gone',
      'codex-local-1',
      'codex-sess-1',
      'codex-title-malformed',
      'codex-title-next',
    ]);
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

  it('uses the first genuine prompt after a pathless bootstrap-only turn', async () => {
    const sessions = (await get('/api/sessions')).json();
    const session = sessions.find((s: { id: string }) => s.id === 'codex-title-next');
    expect(session.title).toBe('name this session from the genuine prompt');
    expect(session.titleDerived).toBe(true);
  });

  it('keeps malformed pathless bootstrap content eligible', async () => {
    const sessions = (await get('/api/sessions')).json();
    const session = sessions.find((s: { id: string }) => s.id === 'codex-title-malformed');
    expect(session.title).toBe('Keep this incomplete wrapper visible');
  });

  it('filters legacy and current guardian reviews without hiding ordinary sessions', async () => {
    const sessions = (await get('/api/sessions')).json();
    const ids = sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain('codex-sess-1');
    expect(ids).toContain('codex-gone');
    expect(ids).not.toContain('codex-guardian-legacy');
    expect(ids).not.toContain('codex-guardian-current');
    expect((await get('/api/sessions/codex-guardian-current')).statusCode).toBe(404);
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

  it('zero-rates a session via a local model_provider propagated session-wide', async () => {
    const sessions = (await get('/api/sessions')).json();
    const s = sessions.find((x: { id: string }) => x.id === 'codex-local-1');
    // model_provider is session-level → stamped on every assistant row, so the
    // provider override zero-rates the session even though gpt-5.4 has a real rate.
    expect(s.totalCostUsd).toBe(0);
    expect(s.providers).toEqual(['lmstudio']);
    expect(s.hasLocalProvider).toBe(true);
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

    expect(detail.subagents).toHaveLength(4);
    const run = detail.subagents.find(
      (candidate: { agentId: string }) => candidate.agentId === '019f2222-aaaa-7bbb-8ccc-000000000001',
    );
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

    // Current format links by output task_name ↔ child agent_path, while the
    // canonical task path replaces the opaque message as the readable label.
    const currentTask = flat.find((b: Record<string, unknown>) => b.id === 'call_spawn2');
    expect(currentTask).toMatchObject({ name: 'Task' });
    expect(currentTask.input).toMatchObject({
      description: '/root/locate_analytics_range',
      subagent_type: 'context_explorer',
    });
    const currentRun = detail.subagents.find(
      (candidate: { agentId: string }) => candidate.agentId === '019f2222-aaaa-7bbb-8ccc-000000000002',
    );
    expect(currentRun).toMatchObject({
      agentType: 'context_explorer',
      description: '/root/locate_analytics_range',
      toolUseId: 'call_spawn2',
    });
    expect(JSON.stringify(currentRun.thread)).toContain('current-format child report');
  });

  it('nests depth-2 rollouts at the spawn call inside their depth-1 child', async () => {
    const detail = (await get('/api/sessions/codex-sess-1')).json();
    const runOf = (id: string) =>
      detail.subagents.find((candidate: { agentId: string }) => candidate.agentId === id);
    /** uuid of the turn in `run`'s thread carrying the tool call `callId`. */
    const spawnUuidIn = (run: { thread: { uuid: string; blocks: { id?: string }[] }[] }, callId: string) =>
      run.thread.find((t) => t.blocks.some((b) => b.id === callId))?.uuid;

    // Both spawn records live in a CHILD's rollout — invisible to the root's own
    // spawn map — and `parent_thread_id` names that child, not the root.
    const current = runOf('019f2222-aaaa-7bbb-8ccc-000000000003');
    expect(current).toMatchObject({
      agentType: 'summarizer',
      description: '/root/locate_analytics_range/summarize_findings',
      toolUseId: 'call_spawn4',
      parentAgentId: '019f2222-aaaa-7bbb-8ccc-000000000002',
    });
    expect(current.spawnUuid).toBe(
      spawnUuidIn(runOf('019f2222-aaaa-7bbb-8ccc-000000000002'), 'call_spawn4'),
    );

    // The legacy form has no `agent_path`: label, type and id come only from the
    // depth-1 child's `agent_id` spawn record.
    const legacy = runOf('019f2222-aaaa-7bbb-8ccc-000000000004');
    expect(legacy).toMatchObject({
      agentType: 'summarizer',
      description: 'Tally the findings.',
      toolUseId: 'call_spawn3',
      parentAgentId: '019f2222-aaaa-7bbb-8ccc-000000000001',
    });
    expect(legacy.spawnUuid).toBe(
      spawnUuidIn(runOf('019f2222-aaaa-7bbb-8ccc-000000000001'), 'call_spawn3'),
    );

    // Neither grandchild's turns leak into the main transcript.
    const main = JSON.stringify(detail.thread);
    expect(main).not.toContain('quokkaline grandchild summary');
    expect(main).not.toContain('wombatcount tally from the grandchild');
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

    const currentExec = flat.find((b: Record<string, unknown>) => b.id === 'call_exec_current');
    expect(currentExec.result.content[0].text).toBe(
      'Script completed\nWall time: 0.1 seconds\nOutput:\n/tmp/codexproj\n',
    );

    const unknown = flat.find((b: Record<string, unknown>) => b.id === 'call_unknown_output');
    expect(unknown.result.content[0].text).toContain('future_content');
    expect(unknown.result.content[0].text).toContain('must-not-vanish');
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

  it('recovers successful nested exec apply_patch calls as canonical edits', async () => {
    const detail = (await get('/api/sessions/codex-sess-1')).json();
    const flat = detail.thread.flatMap(
      (t: { blocks: Record<string, unknown>[] }) => t.blocks,
    );

    const write = flat.find((b: Record<string, unknown>) => b.id === 'call_exec_ap1#0');
    expect(write).toMatchObject({ name: 'Write' });
    expect(write.input).toEqual({ file_path: '/tmp/codexproj/wrapped.md', content: 'wrapped' });
    expect(write.result.content[0].text).toBe('Created /tmp/codexproj/wrapped.md');

    const edit = flat.find((b: Record<string, unknown>) => b.id === 'call_exec_ap1#1');
    expect(edit).toMatchObject({ name: 'MultiEdit' });
    expect(edit.input).toEqual({
      file_path: '/tmp/codexproj/wrapped.ts',
      edits: [{ old_string: 'old wrapped', new_string: 'new wrapped' }],
    });
    expect(edit.result.content[0].text).toBe('Updated /tmp/codexproj/wrapped.ts');

    const direct = flat.find((b: Record<string, unknown>) => b.id === 'call_exec_ap2');
    expect(direct).toMatchObject({ name: 'MultiEdit' });
    expect(direct.input).toEqual({
      file_path: '/tmp/codexproj/direct-wrapped.ts',
      edits: [{ old_string: 'before', new_string: 'after' }],
    });
    expect(direct.result.content[0].text).toBe('Updated /tmp/codexproj/direct-wrapped.ts');
  });

  it('fails closed for rejected, dynamic, ambiguous, and unconfirmed exec patches', async () => {
    const detail = (await get('/api/sessions/codex-sess-1')).json();
    const flat = detail.thread.flatMap(
      (t: { blocks: Record<string, unknown>[] }) => t.blocks,
    );

    const rejected = flat.find((b: Record<string, unknown>) => b.id === 'call_exec_ap3');
    expect(rejected).toMatchObject({ name: 'exec' });
    expect((rejected.input as { file_path?: string }).file_path).toBeUndefined();
    expect(rejected.result.content[0].text).toContain('Script failed');
    expect(rejected.result.content[0].text).toContain('verification failed');

    for (const id of [
      'call_exec_text_only',
      'call_exec_dynamic',
      'call_exec_multiple',
      'call_exec_concat',
      'call_exec_unconfirmed',
    ]) {
      const raw = flat.find((b: Record<string, unknown>) => b.id === id);
      expect(raw).toMatchObject({ name: 'exec' });
      expect((raw.input as { file_path?: string }).file_path).toBeUndefined();
    }

    const canonical = flat.filter((b: Record<string, unknown>) =>
      ['Write', 'Edit', 'MultiEdit'].includes(b.name as string),
    );
    for (const block of canonical) {
      expect((block.input as { file_path: string }).file_path).not.toContain('rejected-wrapped');
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

describe('Codex compaction markers', () => {
  it('counts the `compacted` record once and stamps the turn that follows it', async () => {
    const detail = (await get('/api/sessions/codex-compact-1')).json();
    expect(detail.meta.compactionCount).toBe(1);

    // The stamp lands on the first turn the transcript shows after the boundary.
    const stamped = detail.thread.filter((t: { compaction?: unknown }) => t.compaction);
    expect(stamped).toHaveLength(1);
    expect(JSON.stringify(stamped[0].blocks)).toContain('carry on from the summary');
    expect(stamped[0].compaction).toMatchObject({
      summary: 'squeezed the long haul into this',
      // Codex records no sizes on the marker → derived from the adjacent turns.
      preTokens: 120000,
      postTokens: 9000,
    });
  });

  it('leaves the encrypted `compaction` item and `context_compacted` out of the thread', async () => {
    const detail = (await get('/api/sessions/codex-compact-1')).json();
    const serialized = JSON.stringify(detail.thread);
    expect(serialized).not.toContain('COMPACTION_ENCRYPTED_BLOB');
    expect(serialized).not.toContain('replacement history is not a transcript');
    // The marker is not an event: 2 user + 2 assistant turns, no `system` role.
    expect(detail.meta.messageCount).toBe(4);
    expect(detail.thread.map((t: { role: string }) => t.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});
