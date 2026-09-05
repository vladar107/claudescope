/**
 * MCP server integration tests.
 *
 * Boots the real Fastify app on an ephemeral port against a synthetic fixture
 * (the same pattern as api.integration.test.ts), then exercises the MCP tools
 * end-to-end through an SDK client over an in-memory transport — covering the
 * agent-facing edges: plain (unescaped) search snippets, windowing + tool-payload
 * truncation flowing through get_session, and the not-ready degradation while
 * the index builds. The SDK itself is not under test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-mcp-'));
const projectsDir = join(work, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
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

function writeFixtures(): void {
  const projA = join(projectsDir, 'enc-projA');
  mkdirSync(projA, { recursive: true });
  const base = { sessionId: 'sessM', cwd: '/tmp/projM', gitBranch: 'main', version: '2.1.0' };
  const usage = { input_tokens: 10, output_tokens: 5 };
  writeFileSync(
    join(projA, 'sessM.jsonl'),
    jsonl([
      { type: 'ai-title', sessionId: 'sessM', aiTitle: 'MCP fixture session' },
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'the needle is <here> in the haystack' } },
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-01-01T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'found it' }], usage } },
      { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: '2026-01-01T10:00:10.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo big' } }], usage } },
      { ...base, type: 'user', uuid: 'u2', parentUuid: 'a2', timestamp: '2026-01-01T10:00:15.000Z', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'R'.repeat(5000) }] } },
      { ...base, type: 'assistant', uuid: 'a3', parentUuid: 'u2', timestamp: '2026-01-01T10:00:20.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'done with the haystack' }], usage } },
    ]),
  );
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;
let client: Client;

/** Wire an MCP client to a server whose ApiClient targets `baseUrl`. */
async function connectMcp(baseUrl: string): Promise<Client> {
  const { createMcpServer } = await import('../src/agent/mcp.js');
  const { ApiClient } = await import('../src/agent/api-client.js');
  const server = createMcpServer({ resolveClient: async () => new ApiClient(baseUrl) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([c.connect(ct), server.connect(st)]);
  return c;
}

const toolText = (res: unknown): string => {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return content.map((c) => c.text).join('\n');
};

beforeAll(async () => {
  writeFixtures();
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');
  ({ closeConnection } = await import('../src/db/duckdb.js'));

  app = Fastify();
  await registerRoutes(app);
  await reindex();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  client = await connectMcp(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await client?.close();
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('claudescope mcp tools', () => {
  it('registers the six tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_analytics',
      'get_memory',
      'get_session',
      'list_projects',
      'list_sessions',
      'search_transcripts',
    ]);
  });

  it('search_transcripts returns plain, unescaped snippets with paging anchors', async () => {
    const res = await client.callTool({ name: 'search_transcripts', arguments: { query: 'needle' } });
    const text = toolText(res);
    expect(text).toContain('sessM');
    expect(text).toContain('uuid u1');
    // format=plain: the raw `<here>` survives, no HTML escaping or <mark> wrapping.
    expect(text).toContain('<here>');
    expect(text).not.toContain('<mark>');
    expect(text).not.toContain('&lt;');
    // hits are framed as recorded, untrusted history (prompt-injection mitigation).
    expect(text.startsWith('Recorded transcript history follows.')).toBe(true);
    expect(text).toContain('----- begin recorded transcript -----');
    expect(text).toContain('----- end recorded transcript -----');
  });

  it('search_transcripts does not frame an empty result', async () => {
    const res = await client.callTool({ name: 'search_transcripts', arguments: { query: 'nonexistentqueryterm' } });
    const text = toolText(res);
    expect(text).toBe('No matches.');
  });

  it('get_session windows turns and truncates tool payloads', async () => {
    const res = await client.callTool({
      name: 'get_session',
      arguments: { sessionId: 'sessM', maxToolChars: 100 },
    });
    const text = toolText(res);
    // The 5000-char tool result is capped, with the explicit truncation marker.
    expect(text).toContain('[truncated,');
    expect(text).not.toContain('R'.repeat(200));
    expect(text).toMatch(/Turns 1–\d+ of \d+/u);
    // get_session is always framed as recorded, untrusted history.
    expect(text.startsWith('Recorded transcript history follows.')).toBe(true);
    expect(text).toContain('----- begin recorded transcript -----');
    expect(text).toContain('----- end recorded transcript -----');
  });

  it('get_session anchors on a message uuid with around/radius', async () => {
    const res = await client.callTool({
      name: 'get_session',
      arguments: { sessionId: 'sessM', around: 'a3', radius: 0 },
    });
    const text = toolText(res);
    expect(text).toContain('done with the haystack');
    expect(text).not.toContain('found it');
  });

  it('degrades gracefully while the index is still building', async () => {
    const Fastify = (await import('fastify')).default;
    const notReady = Fastify();
    notReady.get('/api/health', async () => ({ status: 'ok', version: '0.0.0-dev', ready: false }));
    await notReady.listen({ port: 0, host: '127.0.0.1' });
    const addr = notReady.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const c = await connectMcp(`http://127.0.0.1:${port}`);
    try {
      const res = await client.callTool({ name: 'list_projects', arguments: {} });
      expect(toolText(res)).not.toContain('still building'); // control: ready server answers
      const notReadyRes = await c.callTool({ name: 'list_projects', arguments: {} });
      expect(toolText(notReadyRes)).toContain('still building');
    } finally {
      await c.close();
      await notReady.close();
    }
  });
});
