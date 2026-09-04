/**
 * pi connector integration test.
 *
 * Builds the index from synthetic pi session JSONL (in an isolated temp
 * PI_SESSIONS_DIR, with the other agents empty) and exercises the routes,
 * verifying the pi-specific normalization: cwd/session id from the `session`
 * line, model from the assistant message, plaintext thinking (NOT blanked),
 * composite-id tool_use ↔ tool_result pairing, the synthesized thread chain that
 * sidesteps pi's `model_change`/`thinking_level_change` records, correct
 * `gpt-5.4-mini` cost (not the `gpt`-family overcharge), and subagent embedding:
 * a nested `<sessionBase>/<runId>/run-<N>/session.jsonl` child folds into the
 * parent session (searchable, tokens counted, never a top-level session) and
 * nests at its `subagent` toolCall → canonical `Task`, while a management-mode
 * `subagent` call stays passthrough and an orphaned child (no parent file)
 * indexes standalone instead of crashing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const work = mkdtempSync(join(tmpdir(), 'claudescope-pi-'));
const piDir = join(work, 'pi');
const claudeDir = join(work, 'claude-empty');

process.env.CLAUDE_PROJECTS_DIR = claudeDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = piDir;
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ts = (s: number) => `2026-06-15T10:00:${String(s).padStart(2, '0')}.000Z`;
const ts2 = (s: number) => `2026-06-15T11:00:${String(s).padStart(2, '0')}.000Z`;
const ts3 = (s: number) => `2026-06-15T13:00:${String(s).padStart(2, '0')}.000Z`;
const ts4 = (s: number) => `2026-06-15T14:00:${String(s).padStart(2, '0')}.000Z`;

// Composite tool ids as pi writes them (`call_…|fc_…`) — must survive verbatim
// on both the tool_use and its tool_result, or the pairing breaks.
const CALL_A = 'call_AAA|fc_aaa';
const CALL_B = 'call_BBB|fc_bbb';
const CALL_C = 'call_CCC|fc_ccc';
const CALL_M = 'call_MMM|fc_mmm'; // management-mode subagent call
const CALL_S = 'call_SSS|fc_sss'; // spawning subagent call
// The dispatched task; the run must anchor on its FIRST LINE (subagentLabel).
const SCOUT_TASK = 'Map the cave system\nCover every passage.';
// 1x1 transparent PNG (base64) — stands in for a pasted screenshot pi read back.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Write one synthetic pi session under piDir/<encoded-cwd>/. */
function writeSession(): string {
  const dir = join(piDir, '--tmp-piproj--');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '2026-06-15T10-00-00-000Z_019eca90-8e90-7467-bfdf-365232b0c66b.jsonl');
  writeFileSync(
    file,
    jsonl([
      { type: 'session', version: 3, id: 'pi-sess-1', timestamp: ts(0), cwd: '/tmp/piproj' },
      // model_change / thinking_level_change carry the native parent chain that the
      // first user turn points at — the connector must NOT thread through them.
      { type: 'model_change', id: 'mc1', parentId: null, timestamp: ts(0), provider: 'openai-codex', modelId: 'gpt-5.4-mini' },
      { type: 'thinking_level_change', id: 'tl1', parentId: 'mc1', timestamp: ts(0), thinkingLevel: 'high' },
      { type: 'message', id: 'u1', parentId: 'tl1', timestamp: ts(1), message: { role: 'user', content: [{ type: 'text', text: 'find the needle in this pi haystack' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: ts(2), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [
          { type: 'thinking', thinking: 'let me search the haystack', thinkingSignature: '{"id":"rs_enc"}' },
          { type: 'toolCall', id: CALL_A, name: 'bash', arguments: { command: 'grep needle', timeout: 10 } },
          // pi's native edit shape: `{path, edits:[{oldText,newText}]}`.
          { type: 'toolCall', id: CALL_B, name: 'edit', arguments: { path: '/tmp/piproj/hay.txt', edits: [{ oldText: 'hay', newText: 'needle' }] } },
          // pi reads a pasted screenshot from a temp file; the image rides the RESULT.
          { type: 'toolCall', id: CALL_C, name: 'read', arguments: { path: '/tmp/pi-clipboard-x.png' } },
        ],
        usage: { input: 1000, output: 300, cacheRead: 200, cacheWrite: 0, totalTokens: 1500 },
      } },
      // Three consecutive tool results → coalesce into ONE user turn carrying all.
      { type: 'message', id: 'tr1', parentId: 'a1', timestamp: ts(3), message: { role: 'toolResult', toolCallId: CALL_A, toolName: 'bash', content: [{ type: 'text', text: 'needle found at line 42' }] } },
      { type: 'message', id: 'tr2', parentId: 'a1', timestamp: ts(3), message: { role: 'toolResult', toolCallId: CALL_B, toolName: 'edit', content: [{ type: 'text', text: 'edited hay.txt' }] } },
      { type: 'message', id: 'tr3', parentId: 'a1', timestamp: ts(3), message: { role: 'toolResult', toolCallId: CALL_C, toolName: 'read', content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: PNG_B64, mimeType: 'image/png' }] } },
      { type: 'message', id: 'a2', parentId: 'tr2', timestamp: ts(4), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [{ type: 'text', text: 'Found the needle.' }],
        usage: { input: 500, output: 50, cacheRead: 1000, cacheWrite: 0, totalTokens: 1550 },
      } },
    ]),
  );
  return file;
}

/**
 * Write a second session that dispatches a subagent: a management `subagent`
 * call (stays passthrough), a spawning call (→ canonical `Task`), the nested
 * child transcript at `<sessionBase>/<runId>/run-0/session.jsonl`, an ORPHANED
 * child with no parent `.jsonl` sibling (must index standalone), and an
 * UNMATCHED child run no toolResult claims (must attach detached).
 */
function writeSubagentSession(): void {
  const dir = join(piDir, '--tmp-piproj--');
  const base = '2026-06-15T11-00-00-000Z_02aaaaaa-1111-7222-8333-444455556666';
  writeFileSync(
    join(dir, `${base}.jsonl`),
    jsonl([
      { type: 'session', version: 3, id: 'pi-sess-2', timestamp: ts2(0), cwd: '/tmp/piproj' },
      { type: 'message', id: 'u1', parentId: null, timestamp: ts2(1), message: { role: 'user', content: [{ type: 'text', text: 'dispatch a scout to map the caves' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: ts2(2), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [{ type: 'toolCall', id: CALL_M, name: 'subagent', arguments: { action: 'list' } }],
      } },
      // Management action: mode 'management', no runId → no child, stays `subagent`.
      { type: 'message', id: 'tr1', parentId: 'a1', timestamp: ts2(3), message: { role: 'toolResult', toolCallId: CALL_M, toolName: 'subagent', content: [{ type: 'text', text: 'Executable agents:\n- scout' }], details: { mode: 'management', results: [] } } },
      { type: 'message', id: 'a2', parentId: 'tr1', timestamp: ts2(4), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [{ type: 'toolCall', id: CALL_S, name: 'subagent', arguments: { agent: 'scout', task: SCOUT_TASK } }],
      } },
      // The result echoes the task WITH a suffixed output section — the correlation
      // key must come from the toolCall args (first line), not this string.
      { type: 'message', id: 'tr2', parentId: 'a2', timestamp: ts2(20), message: { role: 'toolResult', toolCallId: CALL_S, toolName: 'subagent', content: [{ type: 'text', text: '# Cave map\nAll passages covered.' }], details: { mode: 'single', runId: 'run1abc', results: [{ agent: 'scout', task: `${SCOUT_TASK}\n\n---\n**Output requirements**\nreport back` }] } } },
      { type: 'message', id: 'a3', parentId: 'tr2', timestamp: ts2(21), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [{ type: 'text', text: 'The scout mapped the caves.' }],
      } },
    ]),
  );

  // The child run transcript — nested under the parent's basename dir. Only the
  // child carries usage, so the parent's totalTokens proves sidechain folding.
  const childDir = join(dir, base, 'run1abc', 'run-0');
  mkdirSync(childDir, { recursive: true });
  writeFileSync(
    join(childDir, 'session.jsonl'),
    jsonl([
      { type: 'session', version: 3, id: 'pi-child-1', timestamp: ts2(10), cwd: '/tmp/piproj' },
      { type: 'message', id: 'cu1', parentId: null, timestamp: ts2(11), message: { role: 'user', content: [{ type: 'text', text: 'Map the cave system' }] } },
      { type: 'message', id: 'ca1', parentId: 'cu1', timestamp: ts2(12), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [{ type: 'text', text: 'Stalactite chamber found in the glowworm grotto.' }],
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
      } },
    ]),
  );

  // Orphan: shaped like a child (`run-0/session.jsonl`) but `no-parent-here.jsonl`
  // does not exist — must index as its own session, not crash or key to a dead id.
  const orphanDir = join(dir, 'no-parent-here', 'runX', 'run-0');
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(
    join(orphanDir, 'session.jsonl'),
    jsonl([
      { type: 'session', version: 3, id: 'pi-orphan-1', timestamp: ts2(30), cwd: '/tmp/piproj' },
      { type: 'message', id: 'ou1', parentId: null, timestamp: ts2(31), message: { role: 'user', content: [{ type: 'text', text: 'orphan child with no parent' }] } },
    ]),
  );

  // UNMATCHED child: a run dir no subagent toolResult ever claimed (crashed
  // mid-run). Indexed under the parent (path shape is content-independent), so
  // it must surface in detail as a DETACHED run — not vanish behind a search hit.
  const unmatchedDir = join(dir, base, 'run-crashed', 'run-0');
  mkdirSync(unmatchedDir, { recursive: true });
  writeFileSync(
    join(unmatchedDir, 'session.jsonl'),
    jsonl([
      { type: 'session', version: 3, id: 'pi-child-crashed', timestamp: ts2(25), cwd: '/tmp/piproj' },
      { type: 'message', id: 'xu1', parentId: null, timestamp: ts2(26), message: { role: 'user', content: [{ type: 'text', text: 'abandoned expedition notes' }] } },
    ]),
  );
}

/**
 * A parent whose file holds ONLY the `session` line (zero indexable events) plus
 * a nested child: the session's `files` rows are the child's alone, so
 * loadSession sees no top-level path and must promote the child to the main
 * thread instead of serving an empty detail.
 */
function writeEmptyParentSession(): void {
  const dir = join(piDir, '--tmp-piproj--');
  const base = '2026-06-15T12-00-00-000Z_03bbbbbb-1111-7222-8333-444455556666';
  writeFileSync(
    join(dir, `${base}.jsonl`),
    jsonl([{ type: 'session', version: 3, id: 'pi-empty-parent', timestamp: ts2(40), cwd: '/tmp/piproj' }]),
  );
  const childDir = join(dir, base, 'runZ', 'run-0');
  mkdirSync(childDir, { recursive: true });
  writeFileSync(
    join(childDir, 'session.jsonl'),
    jsonl([
      { type: 'session', version: 3, id: 'pi-child-2', timestamp: ts2(41), cwd: '/tmp/piproj' },
      { type: 'message', id: 'zu1', parentId: null, timestamp: ts2(42), message: { role: 'user', content: [{ type: 'text', text: 'promoted child speaks for the parent' }] } },
    ]),
  );
}

/**
 * A session mixing two providers within ONE session: a `lmstudio` (local, shipped
 * zero-rated) turn and an `openai-codex` (unlisted → priced by model) turn, both on
 * `gpt-5.4-mini`. Proves the per-turn provider CASE: only the openai-codex turn
 * costs anything, both providers surface on the session, and the local one flips
 * `hasLocalProvider`. Prices off the shipped pricing.json (no PRICING_PATH set).
 */
function writeMixedProviderSession(): void {
  const dir = join(piDir, '--tmp-piproj--');
  writeFileSync(
    join(dir, '2026-06-15T13-00-00-000Z_04cccccc-1111-7222-8333-444455556666.jsonl'),
    jsonl([
      { type: 'session', version: 3, id: 'pi-sess-3', timestamp: ts3(0), cwd: '/tmp/piproj' },
      { type: 'message', id: 'u1', parentId: null, timestamp: ts3(1), message: { role: 'user', content: [{ type: 'text', text: 'mix a local model with a cloud one' }] } },
      // Local provider turn: nonzero usage, but zero-rated by the provider override.
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: ts3(2), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'lmstudio',
        content: [{ type: 'text', text: 'answered on the local runtime' }],
        usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 },
      } },
      // Cloud provider turn: unlisted provider → priced by gpt-5.4-mini.
      { type: 'message', id: 'a2', parentId: 'a1', timestamp: ts3(3), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [{ type: 'text', text: 'answered on the cloud model' }],
        usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 300 },
      } },
    ]),
  );
}

/**
 * A session with ONE `compaction` entry: pi records the summary AND the
 * pre-compaction size, so `tokensBefore` must win over the derived figure. The
 * `branch_summary` entry looks similar but marks no compaction.
 */
function writeCompactionSession(): void {
  const dir = join(piDir, '--tmp-piproj--');
  writeFileSync(
    join(dir, '2026-06-15T14-00-00-000Z_05dddddd-1111-7222-8333-444455556666.jsonl'),
    jsonl([
      { type: 'session', version: 3, id: 'pi-compact-1', timestamp: ts4(0), cwd: '/tmp/piproj' },
      { type: 'message', id: 'u1', parentId: null, timestamp: ts4(1), message: { role: 'user', content: [{ type: 'text', text: 'grind through the long haul' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: ts4(2), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [{ type: 'text', text: 'context is filling up' }],
        usage: { input: 90000, output: 400, cacheRead: 30000, cacheWrite: 0, totalTokens: 120400 },
      } },
      { type: 'compaction', id: 'cmp1', parentId: 'a1', timestamp: ts4(3), summary: 'squeezed the long haul into this', firstKeptEntryId: 'u2', tokensBefore: 123456 },
      // Not a compaction — a branch digest. Must not count as a second marker.
      { type: 'branch_summary', id: 'bs1', parentId: 'cmp1', timestamp: ts4(4), summary: 'a branch digest, not a compaction' },
      { type: 'message', id: 'u2', parentId: 'cmp1', timestamp: ts4(5), message: { role: 'user', content: [{ type: 'text', text: 'carry on from the summary' }] } },
      { type: 'message', id: 'a2', parentId: 'u2', timestamp: ts4(6), message: {
        role: 'assistant', model: 'gpt-5.4-mini', provider: 'openai-codex',
        content: [{ type: 'text', text: 'resumed with room to spare' }],
        usage: { input: 9000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 9100 },
      } },
    ]),
  );
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(claudeDir, { recursive: true });
  writeSession();
  writeSubagentSession();
  writeEmptyParentSession();
  writeMixedProviderSession();
  writeCompactionSession();

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

describe('pi session indexing', () => {
  it('lists the pi sessions with model from the assistant message and a pi agent tag', async () => {
    const sessions = (await get('/api/sessions')).json();
    // The nested children (`pi-child-*`) fold into their parents — never
    // top-level sessions; the orphan (parent file missing) stays standalone, and
    // the empty parent is listed via its child's re-keyed rows.
    expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual([
      'pi-compact-1',
      'pi-empty-parent',
      'pi-orphan-1',
      'pi-sess-1',
      'pi-sess-2',
      'pi-sess-3',
    ]);
    const s1 = sessions.find((s: { id: string }) => s.id === 'pi-sess-1');
    expect(s1.models).toContain('gpt-5.4-mini');
    expect(s1.connectorId).toBe('pi');
    // pi has no ai-title, so the title falls back to the first user message.
    expect(s1.title).toBe('find the needle in this pi haystack');
  });

  it('tags the project with its agent and groups analytics by agent', async () => {
    const projects = (await get('/api/projects')).json();
    expect(projects[0].connectorIds).toContain('pi');

    const { rows } = (await get('/api/analytics?groupBy=agent')).json();
    expect(rows.map((r: { key: string }) => r.key)).toContain('pi');
  });

  it('exposes the pi source directory via /api/sources', async () => {
    const sources = (await get('/api/sources')).json();
    expect(sources.some((s: { id: string }) => s.id === 'pi')).toBe(true);
  });

  it('maps usage directly (input excl. cache) and prices gpt-5.4-mini correctly', async () => {
    const s = (await get('/api/sessions')).json().find((x: { id: string }) => x.id === 'pi-sess-1');
    // input is cache-exclusive in pi → totalTokens = Σ(input+output+cacheRead+cacheWrite)
    // = (1000+300+200+0) + (500+50+1000+0) = 3050.
    expect(s.totalTokens).toBe(3050);
    // gpt-5.4-mini @ 0.75/4.50/0.075 per 1M (cacheWrite 0):
    //   turn1 (1000*0.75 + 300*4.5 + 200*0.075)/1e6 = 0.002115
    //   turn2 (500*0.75  +  50*4.5 + 1000*0.075)/1e6 = 0.000675  → total 0.00279.
    // (If it had mis-resolved to the `gpt` family 2.5/15 it would be ~0.00705.)
    expect(s.totalCostUsd).toBeCloseTo(0.00279, 6);
  });

  it('groups analytics by the pi model id', async () => {
    const { rows } = (await get('/api/analytics?groupBy=model')).json();
    expect(rows.map((r: { key: string }) => r.key)).toContain('gpt-5.4-mini');
  });

  it('finds the pi session via full-text search', async () => {
    const { sessions: results } = (await get('/api/search?q=needle')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === 'pi-sess-1')).toBe(true);
  });
});

describe('pi session detail', () => {
  it('renders plaintext thinking, maps pi tools to canonical shapes, and pairs by composite id', async () => {
    const detail = (await get('/api/sessions/pi-sess-1')).json();
    expect(detail.subagents).toEqual([]);

    // The first turn is the user prompt: the synthesized chain starts at the user
    // turn (parentUuid null), NOT dangling off the thinking_level_change record.
    expect(detail.thread[0]).toMatchObject({ role: 'user', parentUuid: null });

    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);

    // pi thinking is PLAINTEXT — the reasoning text must survive (not be blanked).
    const thinking = flat.find((b: Record<string, unknown>) => b.type === 'thinking');
    expect(thinking).toBeTruthy();
    expect(thinking.thinking).toContain('let me search the haystack');

    // All three tool calls pair to their results by the verbatim composite id.
    const tools = flat.filter((b: Record<string, unknown>) => b.kind === 'tool');
    expect(tools.map((t: { id: string }) => t.id).sort()).toEqual([CALL_A, CALL_B, CALL_C].sort());

    // pi `bash` → canonical `Bash` (renders command + output).
    const bash = tools.find((t: { name: string }) => t.name === 'Bash');
    expect(bash.result).toBeTruthy();
    expect(JSON.stringify(bash.result.content)).toContain('needle found at line 42');

    // pi `edit` → canonical `MultiEdit` so the Files-changed tab (changeset.ts)
    // picks it up: file_path + edits[].old_string/new_string. This is the fix for
    // the empty Files-changed tab on pi sessions.
    const edit = tools.find((t: { name: string }) => t.name === 'MultiEdit');
    expect(edit.input).toMatchObject({ file_path: '/tmp/piproj/hay.txt' });
    expect(edit.input.edits[0]).toEqual({ old_string: 'hay', new_string: 'needle' });
    expect(edit.result).toBeTruthy();

    // pi screenshot: the image in the `read` result is preserved as a canonical
    // base64 ImageBlock (so it embeds in the UI instead of being dropped).
    const read = tools.find((t: { name: string }) => t.name === 'Read');
    const img = read.result.content.find((b: { type: string }) => b.type === 'image');
    expect(img).toBeTruthy();
    expect(img.source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG_B64 });

    expect(JSON.stringify(detail.thread)).toContain('Found the needle.');
  });
});

describe('pi subagent embedding', () => {
  it('marks the parent session as having a sidechain and folds child tokens into it', async () => {
    const sessions = (await get('/api/sessions')).json();
    const s2 = sessions.find((s: { id: string }) => s.id === 'pi-sess-2');
    expect(s2.hasSidechain).toBe(true);
    // Only the CHILD carries usage (100 in + 20 out) — the parent total proves
    // the re-keyed sidechain rows are counted under the parent session.
    expect(s2.totalTokens).toBe(120);
    // Fallback title comes from the parent's (earliest) user turn, not the child's.
    expect(s2.title).toBe('dispatch a scout to map the caves');
  });

  it('nests the child run at its spawning toolCall via the canonical Task block', async () => {
    const detail = (await get('/api/sessions/pi-sess-2')).json();
    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);

    // The spawning `subagent` toolCall → canonical `Task`; the description is the
    // task's FIRST LINE, shared with the SubagentSource so the run anchors here.
    const task = flat.find((b: { name?: string }) => b.name === 'Task');
    expect(task.id).toBe(CALL_S);
    expect(task.input).toMatchObject({ description: 'Map the cave system', subagent_type: 'scout' });
    expect(task.input.prompt).toBe(SCOUT_TASK);

    // Two runs: the anchored scout + the detached crashed run (asserted below).
    expect(detail.subagents).toHaveLength(2);
    const run = detail.subagents.find((r: { agentType: string }) => r.agentType === 'scout');
    expect(run).toMatchObject({ agentType: 'scout', description: 'Map the cave system' });
    expect(run.toolUseId).toBe(CALL_S);
    // The child transcript rides the run — not the main thread.
    expect(JSON.stringify(run)).toContain('glowworm grotto');
    expect(JSON.stringify(detail.thread)).not.toContain('glowworm');
  });

  it('attaches an unmatched child run as a detached (unanchored) subagent', async () => {
    const detail = (await get('/api/sessions/pi-sess-2')).json();
    // The crashed run has no claiming toolResult → no description to anchor on,
    // but its events must still be reachable in the detail response.
    const detached = detail.subagents.find((r: { toolUseId?: string }) => !r.toolUseId);
    expect(detached).toMatchObject({ agentType: '', description: '' });
    expect(JSON.stringify(detached)).toContain('abandoned expedition notes');
  });

  it('keeps a management-mode subagent call passthrough (no Task, no run)', async () => {
    const detail = (await get('/api/sessions/pi-sess-2')).json();
    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);
    const mgmt = flat.find((b: { id?: string }) => b.id === CALL_M);
    expect(mgmt.name).toBe('subagent'); // NOT canonicalized — nothing was spawned
    // No run anchors to the management call.
    expect(detail.subagents.some((r: { toolUseId?: string }) => r.toolUseId === CALL_M)).toBe(false);
  });

  it('promotes children to the main thread when the parent contributes no events', async () => {
    // `pi-empty-parent` indexed only its child's rows: loadSession finds no
    // top-level path and must promote the child instead of serving nothing.
    const detail = (await get('/api/sessions/pi-empty-parent')).json();
    expect(JSON.stringify(detail.thread)).toContain('promoted child speaks for the parent');
    expect(detail.subagents).toEqual([]);
  });

  it('finds child-transcript text under the PARENT session via search', async () => {
    const { sessions: results } = (await get('/api/search?q=glowworm')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === 'pi-sess-2')).toBe(true);
    expect(results.every((r: { sessionId: string }) => r.sessionId !== 'pi-child-1')).toBe(true);

    // The unmatched child's text hits the parent too — and the detached run in
    // detail (asserted above) is what makes that hit followable.
    const { sessions: crashed } = (await get('/api/search?q=expedition')).json();
    expect(crashed.some((r: { sessionId: string }) => r.sessionId === 'pi-sess-2')).toBe(true);
  });

  it('indexes an orphaned child (missing parent file) as its own session', async () => {
    const detail = (await get('/api/sessions/pi-orphan-1')).json();
    expect(JSON.stringify(detail.thread)).toContain('orphan child with no parent');
    expect(detail.subagents).toEqual([]);
  });
});

describe('pi provider-aware cost', () => {
  it('records both providers, prices only the cloud turn, and flags the local one', async () => {
    const s = (await get('/api/sessions')).json().find((x: { id: string }) => x.id === 'pi-sess-3');
    // Both per-turn providers surface on the session (CSV order isn't guaranteed).
    expect([...s.providers].sort()).toEqual(['lmstudio', 'openai-codex']);
    // Only the openai-codex turn costs anything: gpt-5.4-mini @ 0.75/4.50,
    // 200 in + 100 out = (200*0.75 + 100*4.5)/1e6 = 0.0006. The lmstudio turn is
    // zero-rated by the shipped provider override despite its 1000+500 usage.
    expect(s.totalCostUsd).toBeCloseTo(0.0006, 6);
    // A zero-rated provider on the session sets the local marker.
    expect(s.hasLocalProvider).toBe(true);
  });
});

describe('pi compaction markers', () => {
  it('counts the compaction entry and stamps the turn after it with pi’s own sizes', async () => {
    const detail = (await get('/api/sessions/pi-compact-1')).json();
    expect(detail.meta.compactionCount).toBe(1); // branch_summary is not one

    const stamped = detail.thread.filter((t: { compaction?: unknown }) => t.compaction);
    expect(stamped).toHaveLength(1);
    expect(JSON.stringify(stamped[0].blocks)).toContain('carry on from the summary');
    expect(stamped[0].compaction).toMatchObject({
      summary: 'squeezed the long haul into this',
      // `tokensBefore` verbatim — NOT the 120000 the previous turn would derive.
      preTokens: 123456,
      postTokens: 9000,
    });
  });

  it('keeps the marker out of the events (no system turn, message count unchanged)', async () => {
    const detail = (await get('/api/sessions/pi-compact-1')).json();
    expect(detail.meta.messageCount).toBe(4);
    expect(detail.thread.map((t: { role: string }) => t.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(JSON.stringify(detail.thread)).not.toContain('a branch digest');
  });
});
