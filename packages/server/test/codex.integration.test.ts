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
      { type: 'response_item', timestamp: ts(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'find the needle in this codex haystack' }] } },
      { type: 'response_item', timestamp: ts(3), payload: { type: 'reasoning', summary: [], content: null, encrypted_content: 'enc-abc' } },
      { type: 'response_item', timestamp: ts(4), payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls -la"}', call_id: 'call_1' } },
      { type: 'response_item', timestamp: ts(5), payload: { type: 'function_call_output', call_id: 'call_1', output: 'file.txt\n' } },
      { type: 'response_item', timestamp: ts(6), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'found it' }] } },
      { type: 'event_msg', timestamp: ts(7), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 300, reasoning_output_tokens: 50, total_tokens: 1300 } }, rate_limits: {} } },
    ]),
  );
  return file;
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(claudeDir, { recursive: true });
  writeRollout();

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
    expect(sessions.map((s: { id: string }) => s.id)).toEqual(['codex-sess-1']);
    expect(sessions[0].models).toContain('gpt-5.4');
    expect(sessions[0].connectorId).toBe('codex');
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

  it('attributes token_count usage and computes a gpt-5.4 cost', async () => {
    const s = (await get('/api/sessions')).json()[0];
    // input 1000 - cached 200 = 800 input; 200 cache_read; 300 output → 1300 total.
    expect(s.totalTokens).toBe(1300);
    // gpt-5.4: (800*2.5 + 300*15 + 200*0.5) / 1e6 = 0.0066
    expect(s.totalCostUsd).toBeCloseTo(0.0066, 5);
  });

  it('groups analytics by the OpenAI model', async () => {
    const { rows } = (await get('/api/analytics?groupBy=model')).json();
    expect(rows.map((r: { key: string }) => r.key)).toContain('gpt-5.4');
  });

  it('finds the Codex session via full-text search', async () => {
    const results = (await get('/api/search?q=needle')).json();
    expect(results.some((r: { sessionId: string }) => r.sessionId === 'codex-sess-1')).toBe(true);
  });
});

describe('Codex session detail', () => {
  it('normalizes response_items into a thread with paired tool call/result', async () => {
    const detail = (await get('/api/sessions/codex-sess-1')).json();
    expect(detail.subagents).toEqual([]);

    // assembleThread pairs tool_use+tool_result into a `kind:'tool'` block and
    // folds the result-only user turn away.
    const flat = detail.thread.flatMap(
      (t: { blocks: Record<string, unknown>[] }) => t.blocks,
    );
    expect(flat.some((b: Record<string, unknown>) => b.type === 'thinking')).toBe(true);

    const tool = flat.find((b: Record<string, unknown>) => b.kind === 'tool');
    expect(tool).toMatchObject({ name: 'exec_command', id: 'call_1' });
    expect(tool.result).toBeTruthy(); // function_call_output paired in

    // The developer (system) message must not appear as a turn.
    const allText = JSON.stringify(detail.thread);
    expect(allText).not.toContain('system instructions');
    expect(allText).toContain('found it');
  });
});
