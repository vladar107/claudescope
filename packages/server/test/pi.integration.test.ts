/**
 * pi connector integration test.
 *
 * Builds the index from a synthetic pi session JSONL (in an isolated temp
 * PI_SESSIONS_DIR, with the other agents empty) and exercises the routes,
 * verifying the pi-specific normalization: cwd/session id from the `session`
 * line, model from the assistant message, plaintext thinking (NOT blanked),
 * composite-id tool_use ↔ tool_result pairing, the synthesized thread chain that
 * sidesteps pi's `model_change`/`thinking_level_change` records, and correct
 * `gpt-5.4-mini` cost (not the `gpt`-family overcharge).
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
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ts = (s: number) => `2026-06-15T10:00:${String(s).padStart(2, '0')}.000Z`;

// Composite tool ids as pi writes them (`call_…|fc_…`) — must survive verbatim
// on both the tool_use and its tool_result, or the pairing breaks.
const CALL_A = 'call_AAA|fc_aaa';
const CALL_B = 'call_BBB|fc_bbb';
const CALL_C = 'call_CCC|fc_ccc';
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

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  mkdirSync(claudeDir, { recursive: true });
  writeSession();

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
  it('lists the pi session with model from the assistant message and a pi agent tag', async () => {
    const sessions = (await get('/api/sessions')).json();
    expect(sessions.map((s: { id: string }) => s.id)).toEqual(['pi-sess-1']);
    expect(sessions[0].models).toContain('gpt-5.4-mini');
    expect(sessions[0].connectorId).toBe('pi');
    // pi has no ai-title, so the title falls back to the first user message.
    expect(sessions[0].title).toBe('find the needle in this pi haystack');
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
    const s = (await get('/api/sessions')).json()[0];
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
