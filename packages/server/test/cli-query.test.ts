/**
 * CLI query subcommand tests.
 *
 * Boots the real Fastify app on an ephemeral port against a synthetic fixture
 * (the mcp.integration.test.ts pattern) and exercises the query functions with
 * a real ApiClient — covering the CLI-specific edges: table shaping with long
 * and non-ASCII titles, --json passthrough (raw response, no redaction), and
 * the --redact flag masking home paths in the human Markdown output only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionDetailResponse, SessionMeta } from '@claudescope/shared';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-cliq-'));
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

const LONG_TITLE = 'A very long session title that keeps going well past the table cell cap ' + 'x'.repeat(40);

function writeFixtures(): void {
  const projA = join(projectsDir, 'enc-projQ');
  mkdirSync(projA, { recursive: true });
  const usage = { input_tokens: 10, output_tokens: 5 };

  // Session 1: long title; a text block with a home path (redaction target).
  const base1 = { sessionId: 'sessQ1', cwd: '/tmp/projQ', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(projA, 'sessQ1.jsonl'),
    jsonl([
      { type: 'ai-title', sessionId: 'sessQ1', aiTitle: LONG_TITLE },
      { ...base1, type: 'user', uuid: 'q1u1', parentUuid: null, timestamp: '2026-01-02T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'where does the needle live?' } },
      { ...base1, type: 'assistant', uuid: 'q1a1', parentUuid: 'q1u1', timestamp: '2026-01-02T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'the needle lives in /Users/testuser/secret/needle.txt' }], usage } },
    ]),
  );

  // Session 2: emoji/non-ASCII title (table must not crash or drop the row).
  const base2 = { sessionId: 'sessQ2', cwd: '/tmp/projQ', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(projA, 'sessQ2.jsonl'),
    jsonl([
      { type: 'ai-title', sessionId: 'sessQ2', aiTitle: '🚀 déjà-vu — fix résumé parsing' },
      { ...base2, type: 'user', uuid: 'q2u1', parentUuid: null, timestamp: '2026-01-03T09:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'unrelated haystack chatter' } },
      { ...base2, type: 'assistant', uuid: 'q2a1', parentUuid: 'q2u1', timestamp: '2026-01-03T09:00:04.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }], usage } },
    ]),
  );
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;
// Typed as the module to keep imports lazy (env vars must be set first).
let query: typeof import('../src/agent/query.js');
let client: import('../src/agent/api-client.js').ApiClient;

beforeAll(async () => {
  writeFixtures();
  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');
  ({ closeConnection } = await import('../src/db/duckdb.js'));
  const { ApiClient } = await import('../src/agent/api-client.js');
  query = await import('../src/agent/query.js');

  app = Fastify();
  await registerRoutes(app);
  await reindex();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  client = new ApiClient(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('cli query subcommands', () => {
  it('sessions renders an aligned table, clipping long titles and keeping non-ASCII rows', async () => {
    const out = await query.querySessions(client, {});
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^ID\s+AGENT\s+BRANCH\s+TITLE\s+DATE\s+MSGS\s+TOKENS\s+COST$/u);
    // Every row's AGENT column starts where the header's does (pad-aligned).
    const agentCol = lines[0]!.indexOf('AGENT');
    for (const row of lines.slice(1)) expect(row.slice(agentCol)).toMatch(/^claude-code\s+main\s/u);
    // The long title is clipped with an ellipsis, never dumped whole.
    expect(out).toContain('…');
    expect(out).not.toContain(LONG_TITLE);
    // The emoji title survives as a row.
    expect(out).toContain('🚀 déjà-vu');
  });

  it('sessions --cwd resolves the working directory to the fixture project', async () => {
    const hit = await query.querySessions(client, { cwd: '/tmp/projQ/', json: true });
    expect((JSON.parse(hit) as SessionMeta[]).map((r) => r.id).sort()).toEqual(['sessQ1', 'sessQ2']);
    const miss = await query.querySessions(client, { cwd: '/tmp/nowhere' });
    expect(miss).toBe('No sessions match.');
  });

  it('sessions --json returns the raw rows', async () => {
    const out = await query.querySessions(client, { json: true });
    const rows = JSON.parse(out) as SessionMeta[];
    expect(rows.map((r) => r.id).sort()).toEqual(['sessQ1', 'sessQ2']);
    expect(rows[0]).toHaveProperty('totalCostUsd');
  });

  it('search returns plain snippets; no hits is normal output', async () => {
    const hit = await query.querySearch(client, { query: 'needle' });
    expect(hit).toContain('sessQ1');
    expect(hit).not.toContain('<mark>');
    const miss = await query.querySearch(client, { query: 'zebra-quux-nonexistent' });
    expect(miss).toBe('No matches.');
  });

  it('session --redact masks home paths in Markdown, while --json stays raw', async () => {
    const plain = await query.querySession(client, 'sessQ1', {});
    expect(plain).toContain('/Users/testuser/secret/needle.txt');
    expect(plain).toMatch(/Turns 1–\d+ of \d+/u);

    const redacted = await query.querySession(client, 'sessQ1', { redact: true });
    expect(redacted).not.toContain('/Users/testuser');
    expect(redacted).toContain('~/secret/needle.txt');

    // --json is the raw API response: window metadata present, redact ignored.
    const raw = JSON.parse(await query.querySession(client, 'sessQ1', { redact: true, json: true })) as SessionDetailResponse;
    expect(raw.window).toMatchObject({ offset: 0 });
    expect(JSON.stringify(raw)).toContain('/Users/testuser/secret/needle.txt');
  });

  it('analytics renders rows plus a totals line', async () => {
    const out = await query.queryAnalytics(client, { groupBy: 'agent' });
    expect(out).toContain('claude-code');
    expect(out).toMatch(/Total: [\d,]+ tok · \$\d/u);
  });
});
