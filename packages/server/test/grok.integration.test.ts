/**
 * xAI Grok CLI connector integration test.
 *
 * Builds the index from synthetic Grok session dirs (in an isolated temp
 * GROK_SESSIONS_DIR, with the other agents empty) and exercises the routes,
 * verifying the grok-specific normalization: the chat_history/updates/summary
 * three-file split (timestamps + usage come from updates.jsonl, title from
 * summary.json), the injected-row skip (system + prompt_index-less user rows),
 * the `<user_query>` wrapper strip (visible in the fallback title), plaintext
 * reasoning summaries (NOT blanked), tool canonicalization (search_replace →
 * Edit reaching the Files-changed extractor shape), inline data-URL images,
 * the input-minus-cachedRead usage split priced at the shipped grok-4.5 rate,
 * and subagent embedding: a SIBLING child session dir folds into the parent
 * (searchable, tokens counted, never top-level) via the parent's
 * `subagents/<id>/meta.json`, anchoring at its `spawn_subagent` → `Task`,
 * while an orphaned child (no parent claims it) indexes standalone. A missing
 * updates.jsonl and a corrupt trailing chat line must degrade, not crash.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const work = mkdtempSync(join(tmpdir(), 'claudescope-grok-'));
const grokDir = join(work, 'grok');
const claudeDir = join(work, 'claude-empty');

process.env.CLAUDE_PROJECTS_DIR = claudeDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.GROK_SESSIONS_DIR = grokDir;
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const CWD_DIR = join(grokDir, '%2Ftmp%2Fgrokproj');
const BASE_MS = Date.parse('2026-06-20T10:00:00.000Z');
const iso = (s: number) => new Date(BASE_MS + s * 1000).toISOString();

const CALL_READ = 'call-aaaa-0';
const CALL_EDIT = 'call-aaaa-1';
const CALL_BASH = 'call-aaaa-2';
const CALL_MCP = 'call-aaaa-3';
const CALL_SPAWN = 'call-bbbb-0';
// 1x1 transparent PNG (base64) — stands in for a pasted screenshot.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** One ACP-style updates.jsonl line. */
const update = (ms: number, sessionUpdate: Record<string, unknown>, meta?: Record<string, unknown>) => ({
  timestamp: Math.floor(ms / 1000),
  method: 'session/update',
  params: {
    sessionId: 'x',
    update: sessionUpdate,
    _meta: { eventId: `e-${ms}`, agentTimestampMs: ms, ...meta },
  },
});

function writeSummary(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      info: { id, cwd: '/tmp/grokproj' },
      created_at: iso(0),
      updated_at: iso(120),
      current_model_id: 'grok-4.5',
      ...extra,
    }),
  );
}

/**
 * The full-feature main session: injected rows to skip, a wrapped + image user
 * prompt, plaintext reasoning, canonical tool mapping, and a turn_completed
 * whose cachedReadTokens must be split OUT of inputTokens.
 */
function writeMainSession(): void {
  const dir = join(CWD_DIR, 'grok-sess-1');
  mkdirSync(dir, { recursive: true });
  writeSummary(dir, 'grok-sess-1', { generated_title: 'Needle hunt in the grok haystack' });
  writeFileSync(
    join(dir, 'chat_history.jsonl'),
    jsonl([
      { type: 'system', content: 'You are Grok. secret-system-marker' },
      // Injected context rows: no prompt_index (with and without synthetic_reason).
      { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS: macos injected-info-marker\n</user_info>' }] },
      { type: 'user', content: [{ type: 'text', text: 'project instructions injected-agents-marker' }], synthetic_reason: 'agents_md' },
      {
        type: 'user',
        prompt_index: 0,
        content: [
          // A pasted image injects an <image_files> scaffold INSIDE the same
          // text part, before the <user_query> tag — both must be stripped.
          {
            type: 'text',
            text: '<image_files>\nThe following images were provided by the user and saved to the workspace for future use:\n1. /tmp/grokproj/assets/image-1.png scaffold-marker\n</image_files>\n\n<user_query>\nfind the needle in the grok haystack [Image #1] \n</user_query>',
          },
          { type: 'image', url: `data:image/png;base64,${PNG_B64}` },
          { type: 'image', url: 'https://example.com/not-inline.png' }, // non-data URL → skipped
        ],
      },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'let me grep the grok haystack' }],
        encrypted_content: 'OPAQUE',
        status: 'completed',
      },
      {
        type: 'assistant',
        content: 'Searching now.',
        model_id: 'grok-4.5',
        tool_calls: [
          { id: CALL_READ, name: 'read_file', arguments: JSON.stringify({ target_file: '/tmp/grokproj/hay.txt' }) },
          { id: CALL_EDIT, name: 'search_replace', arguments: JSON.stringify({ file_path: '/tmp/grokproj/hay.txt', old_string: 'hay', new_string: 'needle' }) },
          { id: CALL_BASH, name: 'run_terminal_command', arguments: JSON.stringify({ command: 'grep needle hay.txt', description: 'Search the haystack' }) },
          { id: CALL_MCP, name: 'context7__query-docs', arguments: JSON.stringify({ query: 'needles' }) },
        ],
      },
      { type: 'tool_result', tool_call_id: CALL_READ, content: '1→hay in the stack' },
      { type: 'tool_result', tool_call_id: CALL_EDIT, content: 'The file hay.txt has been edited' },
      { type: 'tool_result', tool_call_id: CALL_BASH, content: 'needle found at line 42' },
      { type: 'tool_result', tool_call_id: CALL_MCP, content: 'docs about needles' },
      { type: 'assistant', content: 'Found the needle.', model_id: 'grok-4.5' },
    ]),
  );
  writeFileSync(
    join(dir, 'updates.jsonl'),
    jsonl([
      update(BASE_MS + 1000, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'find the needle' }, _meta: { promptIndex: 0 } }),
      update(BASE_MS + 5000, { sessionUpdate: 'tool_call', toolCallId: CALL_READ, title: 'read_file' }),
      update(BASE_MS + 6000, { sessionUpdate: 'tool_call', toolCallId: CALL_EDIT, title: 'search_replace' }),
      // cachedReadTokens is a SUBSET of inputTokens → indexed input must be 1000.
      update(BASE_MS + 30000, {
        sessionUpdate: 'turn_completed',
        prompt_id: 'p-1',
        stop_reason: 'end_turn',
        usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cachedReadTokens: 200, reasoningTokens: 40, modelCalls: 2 },
      }),
    ]),
  );
}

/**
 * A parent that spawns a subagent. The child is a SIBLING session dir; the only
 * linkage is the parent's `subagents/<child-id>/meta.json`. Only the child and
 * parent carry usage via their own updates.jsonl — the parent's session totals
 * prove the re-keyed sidechain rows fold in.
 */
function writeSubagentPair(): void {
  const parentDir = join(CWD_DIR, 'grok-sess-2');
  mkdirSync(parentDir, { recursive: true });
  writeSummary(parentDir, 'grok-sess-2', { generated_title: 'Dispatch a cave reviewer' });
  writeFileSync(
    join(parentDir, 'chat_history.jsonl'),
    jsonl([
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_query>\ndispatch a reviewer to the caves\n</user_query>' }] },
      {
        type: 'assistant',
        content: 'Spawning a reviewer.',
        model_id: 'grok-4.5',
        tool_calls: [
          { id: CALL_SPAWN, name: 'spawn_subagent', arguments: JSON.stringify({ description: 'Review the cave code', prompt: 'Review the caves\nthoroughly.' }) },
        ],
      },
      { type: 'tool_result', tool_call_id: CALL_SPAWN, content: 'subagent_id: grok-child-1\nstatus: started' },
      { type: 'assistant', content: 'The reviewer finished.', model_id: 'grok-4.5' },
    ]),
  );
  writeFileSync(
    join(parentDir, 'updates.jsonl'),
    jsonl([
      update(BASE_MS + 1000, {
        sessionUpdate: 'turn_completed',
        prompt_id: 'p-1',
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedReadTokens: 0 },
      }),
    ]),
  );
  const metaDir = join(parentDir, 'subagents', 'grok-child-1');
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(
    join(metaDir, 'meta.json'),
    JSON.stringify({
      subagent_id: 'grok-child-1',
      parent_session_id: 'grok-sess-2',
      child_session_id: 'grok-child-1',
      subagent_type: 'general-purpose',
      description: 'Review the cave code',
      prompt: 'Review the caves\nthoroughly.',
      status: 'completed',
    }),
  );

  const childDir = join(CWD_DIR, 'grok-child-1');
  mkdirSync(childDir, { recursive: true });
  writeSummary(childDir, 'grok-child-1', {
    session_kind: 'subagent',
    agent_name: 'general-purpose',
    // The child has its own title — it must NOT leak onto the parent session.
    generated_title: 'Review the caves thoroughly',
  });
  writeFileSync(
    join(childDir, 'chat_history.jsonl'),
    jsonl([
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_query>\nReview the caves\nthoroughly.\n</user_query>' }] },
      { type: 'assistant', content: 'Cave review done: the glowworm grotto is sound.', model_id: 'grok-4.5' },
    ]),
  );
  writeFileSync(
    join(childDir, 'updates.jsonl'),
    jsonl([
      update(BASE_MS + 2000, {
        sessionUpdate: 'turn_completed',
        prompt_id: 'p-c1',
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70, cachedReadTokens: 0 },
      }),
    ]),
  );
}

/**
 * Degraded session: NO updates.jsonl (timestamps fall back to summary times,
 * zero usage), no generated_title (fallback title = stripped first user
 * message), and a corrupt trailing chat line to tolerate.
 */
function writeDegradedSession(): void {
  const dir = join(CWD_DIR, 'grok-sess-3');
  mkdirSync(dir, { recursive: true });
  writeSummary(dir, 'grok-sess-3');
  writeFileSync(
    join(dir, 'chat_history.jsonl'),
    jsonl([
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_query>\nchart the abyssal trench\n</user_query>' }] },
      { type: 'assistant', content: 'Trench charted.', model_id: 'grok-4.5' },
    ]) + '{"type":"assis', // truncated mid-write
  );
}

/** An orphaned subagent child: no parent's subagents/ dir claims it. */
function writeOrphanChild(): void {
  const dir = join(CWD_DIR, 'grok-orphan-1');
  mkdirSync(dir, { recursive: true });
  writeSummary(dir, 'grok-orphan-1', { session_kind: 'subagent' });
  writeFileSync(
    join(dir, 'chat_history.jsonl'),
    jsonl([
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: 'orphan child with no parent' }] },
      { type: 'assistant', content: 'Standing alone.', model_id: 'grok-4.5' },
    ]),
  );
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(claudeDir, { recursive: true });
  // A stray non-session file at the sessions root (grok writes one) — must be skipped.
  mkdirSync(grokDir, { recursive: true });
  writeFileSync(join(grokDir, 'session_search.sqlite'), 'not jsonl');
  writeMainSession();
  writeSubagentPair();
  writeDegradedSession();
  writeOrphanChild();
  // The per-cwd prompt_history.jsonl grok keeps next to session dirs — skipped by shape.
  writeFileSync(join(CWD_DIR, 'prompt_history.jsonl'), jsonl([{ prompt: 'not a session' }]));

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

describe('grok session indexing', () => {
  it('lists the grok sessions (child folds into parent; orphan stays standalone)', async () => {
    const sessions = (await get('/api/sessions')).json();
    expect(sessions.map((s: { id: string }) => s.id).sort()).toEqual([
      'grok-orphan-1',
      'grok-sess-1',
      'grok-sess-2',
      'grok-sess-3',
    ]);
    const s1 = sessions.find((s: { id: string }) => s.id === 'grok-sess-1');
    expect(s1.connectorId).toBe('grok');
    expect(s1.models).toContain('grok-4.5');
    // The real title comes from summary.json's generated_title.
    expect(s1.title).toBe('Needle hunt in the grok haystack');
  });

  it('falls back to the stripped first user message when summary has no title', async () => {
    const s3 = (await get('/api/sessions')).json().find((x: { id: string }) => x.id === 'grok-sess-3');
    // No <user_query> wrapper — proves stripUserQuery feeds the title fallback.
    expect(s3.title).toBe('chart the abyssal trench');
  });

  it('splits cachedReadTokens out of inputTokens and prices at the grok-4.5 rate', async () => {
    const s1 = (await get('/api/sessions')).json().find((x: { id: string }) => x.id === 'grok-sess-1');
    // input 1200 includes 200 cached reads → indexed as 1000 in + 300 out + 200 cacheRead.
    expect(s1.totalTokens).toBe(1500);
    // grok-4.5 @ 2/6 (cacheRead 0.5) per 1M: (1000*2 + 300*6 + 200*0.5)/1e6 = 0.0039.
    // (The 3/15 default rate would give ~0.0076 — proves the shipped grok entry resolves.)
    expect(s1.totalCostUsd).toBeCloseTo(0.0039, 6);
  });

  it('indexes a session with NO updates.jsonl (zero usage, summary timestamps)', async () => {
    const s3 = (await get('/api/sessions')).json().find((x: { id: string }) => x.id === 'grok-sess-3');
    expect(s3.totalTokens).toBe(0);
    expect(s3.totalCostUsd).toBe(0);
  });

  it('keeps injected context rows out of the index and search', async () => {
    for (const marker of ['injected-info-marker', 'injected-agents-marker', 'secret-system-marker']) {
      const { sessions: hits } = (await get(`/api/search?q=${marker}`)).json();
      expect(hits).toEqual([]);
    }
    // The real prompt IS searchable (with the wrapper stripped at index time).
    const { sessions: hits } = (await get('/api/search?q=haystack')).json();
    expect(hits.some((r: { sessionId: string }) => r.sessionId === 'grok-sess-1')).toBe(true);
  });

  it('exposes the grok source dir and groups analytics by agent', async () => {
    const sources = (await get('/api/sources')).json();
    expect(sources.some((s: { id: string }) => s.id === 'grok')).toBe(true);
    const { rows } = (await get('/api/analytics?groupBy=agent')).json();
    expect(rows.map((r: { key: string }) => r.key)).toContain('grok');
  });
});

describe('grok session detail', () => {
  it('renders plaintext reasoning, strips the user_query wrapper, embeds the image, maps tools', async () => {
    const detail = (await get('/api/sessions/grok-sess-1')).json();
    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);
    const all = JSON.stringify(detail.thread);

    // Injected rows never render as user turns.
    expect(all).not.toContain('injected-info-marker');
    expect(all).not.toContain('injected-agents-marker');
    // The wrapper AND the pasted-image scaffold are stripped from the prompt;
    // the inline [Image #N] marker the user's text carries survives.
    expect(all).not.toContain('<user_query>');
    expect(all).not.toContain('image_files');
    expect(all).not.toContain('scaffold-marker');
    expect(all).toContain('find the needle in the grok haystack [Image #1]');

    // Grok reasoning summaries are PLAINTEXT — must survive, not render blank.
    const thinking = flat.find((b: Record<string, unknown>) => b.type === 'thinking');
    expect(thinking.thinking).toContain('let me grep the grok haystack');

    // The pasted screenshot embeds as a canonical base64 ImageBlock (rendered
    // as an attachment); the non-data URL part is dropped, not a crash.
    const attachments = flat.filter((b: Record<string, unknown>) => b.kind === 'attachment');
    expect(attachments).toHaveLength(1);
    expect(attachments[0].attachment).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_B64 },
    });

    const tools = flat.filter((b: Record<string, unknown>) => b.kind === 'tool');
    // read_file → Read keyed by file_path (from target_file).
    const read = tools.find((t: { name: string }) => t.name === 'Read');
    expect(read.input).toMatchObject({ file_path: '/tmp/grokproj/hay.txt' });
    expect(JSON.stringify(read.result.content)).toContain('hay in the stack');
    // search_replace → Edit in the exact shape the Files-changed extractor keys off.
    const edit = tools.find((t: { name: string }) => t.name === 'Edit');
    expect(edit.input).toMatchObject({
      file_path: '/tmp/grokproj/hay.txt',
      old_string: 'hay',
      new_string: 'needle',
    });
    expect(edit.result).toBeTruthy();
    // run_terminal_command → Bash.
    const bash = tools.find((t: { name: string }) => t.name === 'Bash');
    expect(bash.input).toMatchObject({ command: 'grep needle hay.txt' });
    expect(JSON.stringify(bash.result.content)).toContain('needle found at line 42');
    // MCP tools stay passthrough under their namespaced native name.
    const mcp = tools.find((t: { id: string }) => t.id === CALL_MCP);
    expect(mcp.name).toBe('context7__query-docs');

    expect(all).toContain('Found the needle.');
  });

  it('tolerates a corrupt trailing chat line', async () => {
    const detail = (await get('/api/sessions/grok-sess-3')).json();
    expect(JSON.stringify(detail.thread)).toContain('Trench charted.');
  });
});

describe('grok subagent embedding', () => {
  it('folds the sibling child into the parent (sidechain + tokens)', async () => {
    const s2 = (await get('/api/sessions')).json().find((x: { id: string }) => x.id === 'grok-sess-2');
    expect(s2.hasSidechain).toBe(true);
    // parent 100+10 (+0 cached) + child 50+20 — child rows count under the parent.
    expect(s2.totalTokens).toBe(180);
    // The PARENT's generated_title must win — the child file's re-keyed rows
    // (same session_id) must not overwrite it with the child's own title.
    expect(s2.title).toBe('Dispatch a cave reviewer');
  });

  it('nests the child at its spawn_subagent call via the canonical Task block', async () => {
    const detail = (await get('/api/sessions/grok-sess-2')).json();
    const flat = detail.thread.flatMap((t: { blocks: Record<string, unknown>[] }) => t.blocks);

    const task = flat.find((b: { name?: string }) => b.name === 'Task');
    expect(task.id).toBe(CALL_SPAWN);
    // subagent_type comes from the parent's meta.json, matched by description.
    expect(task.input).toMatchObject({
      description: 'Review the cave code',
      subagent_type: 'general-purpose',
      prompt: 'Review the caves\nthoroughly.',
    });

    expect(detail.subagents).toHaveLength(1);
    const run = detail.subagents[0];
    expect(run).toMatchObject({ agentType: 'general-purpose', description: 'Review the cave code' });
    expect(run.toolUseId).toBe(CALL_SPAWN);
    // The child transcript rides the run — not the main thread.
    expect(JSON.stringify(run)).toContain('glowworm grotto');
    expect(JSON.stringify(detail.thread)).not.toContain('glowworm');
  });

  it('finds child-transcript text under the PARENT session via search', async () => {
    const { sessions: results } = (await get('/api/search?q=glowworm')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === 'grok-sess-2')).toBe(true);
    expect(results.every((r: { sessionId: string }) => r.sessionId !== 'grok-child-1')).toBe(true);
  });

  it('indexes an orphaned child (no parent claims it) as its own session', async () => {
    const detail = (await get('/api/sessions/grok-orphan-1')).json();
    expect(JSON.stringify(detail.thread)).toContain('orphan child with no parent');
    expect(detail.subagents).toEqual([]);
  });
});
