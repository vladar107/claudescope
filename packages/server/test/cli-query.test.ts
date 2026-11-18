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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AnalyticsResponse, SearchResponse, SessionDetailResponse, SessionMeta } from '@claudescope/shared';

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
      { ...base2, type: 'assistant', uuid: 'q2a1', parentUuid: 'q2u1', timestamp: '2026-01-03T09:00:04.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }], usage } },
    ]),
  );

  // Session 3: a subagent spawning a subagent — `session --redact`/plain
  // Markdown must nest the grandchild under its parent, not the main thread.
  // Kept in its own project so it doesn't shift the `/tmp/projQ`-scoped
  // assertions above.
  const projN = join(projectsDir, 'enc-projN');
  const subN = join(projN, 'sessN', 'subagents');
  mkdirSync(subN, { recursive: true });
  const baseN = { sessionId: 'sessN', cwd: '/tmp/projN', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(projN, 'sessN.jsonl'),
    jsonl([
      { type: 'ai-title', sessionId: 'sessN', aiTitle: 'Nested subagent session' },
      { ...baseN, type: 'user', uuid: 'n-u1', parentUuid: null, timestamp: '2026-01-04T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'go explore' } },
      { ...baseN, type: 'assistant', uuid: 'n-a1', parentUuid: 'n-u1', timestamp: '2026-01-04T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'tu_outer', name: 'Agent', input: { description: 'Outer explore', subagent_type: 'Explore', prompt: 'explore outer' } }], usage } },
      { ...baseN, type: 'user', uuid: 'n-u2', parentUuid: 'n-a1', timestamp: '2026-01-04T10:01:00.000Z', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_outer', content: 'outer done' }] } },
    ]),
  );
  const subBaseN = { sessionId: 'sessN', cwd: '/tmp/projN', isSidechain: true };
  writeFileSync(
    join(subN, 'agent-outer.jsonl'),
    jsonl([
      { ...subBaseN, type: 'user', uuid: 'so-u1', parentUuid: null, agentId: 'outer', timestamp: '2026-01-04T10:00:10.000Z', message: { role: 'user', content: 'explore outer' } },
      { ...subBaseN, type: 'assistant', uuid: 'so-a1', parentUuid: 'so-u1', agentId: 'outer', timestamp: '2026-01-04T10:00:20.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'tu_inner', name: 'Agent', input: { description: 'Inner probe', subagent_type: 'general-purpose', prompt: 'probe inner' } }], usage } },
    ]),
  );
  writeFileSync(join(subN, 'agent-outer.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Outer explore', toolUseId: 'tu_outer' }));
  writeFileSync(
    join(subN, 'agent-inner.jsonl'),
    jsonl([
      { ...subBaseN, type: 'user', uuid: 'si-u1', parentUuid: null, agentId: 'inner', timestamp: '2026-01-04T10:00:25.000Z', message: { role: 'user', content: 'probe inner' } },
      { ...subBaseN, type: 'assistant', uuid: 'si-a1', parentUuid: 'si-u1', agentId: 'inner', timestamp: '2026-01-04T10:00:30.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'probed' }], usage } },
    ]),
  );
  writeFileSync(
    join(subN, 'agent-inner.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Inner probe', toolUseId: 'tu_inner', parentAgentId: 'outer' }),
  );

  // Back-date every transcript so none is in the live window (which reads file
  // mtimes): `resolve` must then answer from the newest session, not timing.
  const past = new Date('2026-01-05T00:00:00.000Z');
  for (const f of readdirSync(projectsDir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) utimesSync(join(f.parentPath, f.name), past, past);
  }
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
    expect(rows.map((r) => r.id).sort()).toEqual(['sessN', 'sessQ1', 'sessQ2']);
    expect(rows[0]).toHaveProperty('totalCostUsd');
  });

  it('search returns plain snippets; no hits is normal output', async () => {
    const hit = await query.querySearch(client, { query: 'needle' });
    expect(hit).toContain('sessQ1');
    expect(hit).not.toContain('<mark>');
    const miss = await query.querySearch(client, { query: 'zebra-quux-nonexistent' });
    expect(miss).toBe('No matches.');
  });

  it('search --literal survives the boolean→query-param hop', async () => {
    const hit = await query.querySearch(client, { query: 'secret/needle.txt', literal: true });
    expect(hit).toContain('sessQ1');
    const miss = await query.querySearch(client, { query: 'zzz-none', literal: true });
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

  it('session nests a subagent-spawned subagent under its parent, depth-first', async () => {
    const out = await query.querySession(client, 'sessN', {});
    expect(out).toContain('--- subagent · Explore — Outer explore ---');
    expect(out).toContain('--- subagent · general-purpose — Inner probe · nested in Outer explore ---');
    expect(out.indexOf('Outer explore')).toBeLessThan(out.indexOf('Inner probe'));
  });

  it('analytics renders rows plus a totals line', async () => {
    const out = await query.queryAnalytics(client, { groupBy: 'agent' });
    expect(out).toContain('claude-code');
    expect(out).toMatch(/Total: [\d,]+ tok · \$\d/u);
  });

  it('analytics --group-by tool renders a KEY/AGENT/COUNT table, no totals line', async () => {
    const out = await query.queryAnalytics(client, { groupBy: 'tool' });
    expect(out).toMatch(/^KEY\s+AGENT\s+COUNT$/mu);
    expect(out).toContain('claude-code');
    expect(out).not.toContain('Total:');
  });

  it('search hits carry the session\'s agent, end time, and cost', async () => {
    const metas = JSON.parse(await query.querySessions(client, { json: true })) as SessionMeta[];
    const meta = metas.find((m) => m.id === 'sessQ1');
    expect(meta?.totalCostUsd).toBeGreaterThan(0);
    for (const literal of [false, true]) {
      const res = JSON.parse(await query.querySearch(client, { query: 'needle', literal, json: true })) as SearchResponse;
      const hit = res.sessions.find((h) => h.sessionId === 'sessQ1');
      expect(hit).toMatchObject({ connectorId: 'claude-code', endedAt: '2026-01-02T10:00:05.000Z' });
      expect(hit?.totalCostUsd).toBe(meta?.totalCostUsd);
    }
  });

  it('analytics --project narrows project and day grouping to that project\'s row', async () => {
    const all = JSON.parse(await query.queryAnalytics(client, { groupBy: 'project', json: true })) as AnalyticsResponse;
    expect(all.rows.length).toBe(2);
    for (const row of all.rows) {
      for (const groupBy of ['project', 'day'] as const) {
        const scoped = JSON.parse(
          await query.queryAnalytics(client, { groupBy, project: row.key, json: true }),
        ) as AnalyticsResponse;
        expect(scoped.totals.totalTokens).toBe(row.totalTokens);
        expect(scoped.totals.messageCount).toBe(row.messageCount);
        expect(scoped.totals.costUsd).toBeCloseTo(row.costUsd, 10);
      }
    }
    const unknown = JSON.parse(
      await query.queryAnalytics(client, { groupBy: 'model', project: 'no-such-project', json: true }),
    ) as AnalyticsResponse;
    expect(unknown.rows).toEqual([]);
  });

  it('resolve: exact id, unknown id falling back to the folder, nearest ancestor, and no match', async () => {
    const resolve = async (args: { session?: string; cwd?: string }) =>
      JSON.parse(await query.queryResolve(client, { ...args, json: true })) as {
        match: string;
        project: { id: string; cwd: string; match: string } | null;
        sessions: { meta: SessionMeta; live: boolean }[];
      };

    const byId = await resolve({ session: 'sessQ1', cwd: '/tmp/projN' });
    expect(byId.match).toBe('id');
    expect(byId.project).toMatchObject({ cwd: '/tmp/projQ', match: 'exact' });
    expect(byId.sessions.map((s) => [s.meta.id, s.live])).toEqual([['sessQ1', false]]);

    // An id the index does not know falls through to the folder, and a
    // subdirectory (that does not even exist) resolves to its project.
    const byFolder = await resolve({ session: 'not-a-session', cwd: '/tmp/projQ/packages/web/' });
    expect(byFolder.match).toBe('recent');
    expect(byFolder.project).toMatchObject({ cwd: '/tmp/projQ', match: 'ancestor' });
    expect(byFolder.sessions.map((s) => [s.meta.id, s.live])).toEqual([['sessQ2', false]]);

    expect(await resolve({ session: 'not-a-session' })).toEqual({ match: 'none', project: null, sessions: [] });
    expect(await resolve({ cwd: '/claudescope-test-nowhere/deeper' })).toEqual({
      match: 'none',
      project: null,
      sessions: [],
    });

    // Human output: one line per candidate, led by the match kind.
    expect(await query.queryResolve(client, { session: 'sessQ1' })).toMatch(/^id\s+sessQ1\s+claude-code\s/u);
    expect(await query.queryResolve(client, { cwd: '/claudescope-test-nowhere' })).toMatch(/^none\b/u);
  });
});
