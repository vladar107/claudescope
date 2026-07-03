/**
 * /api/analytics/digest integration tests — composition edges, per the repo
 * doctrine:
 *
 *  1. Totals with a no-usage agent in range — Junie-with-tokens and Claude
 *     sessions sum, while the digest never NaNs or zeroes out because one
 *     agent's metrics are unavailable; the reliability rollup lists Junie as
 *     "no signal" instead of counting it.
 *  2. Empty range → a coherent empty digest (zero totals, empty lists, null
 *     biggest session — no NaN anywhere).
 *  3. Code impact comes from canonical `file_edits` joined to the scoped
 *     sessions (an edit inside the range's session counts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DigestResponse } from '@claudescope/shared';

const work = mkdtempSync(join(tmpdir(), 'claudescope-digest-'));
const projectsDir = join(work, 'projects');
const junieDir = join(work, 'junie');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = join(work, 'codex-empty');
process.env.JUNIE_SESSIONS_DIR = junieDir;
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
const CWD = '/tmp/digestproj';

/** Claude session: one costed response, one Edit (2 adds / 1 del), one interrupt. */
function writeClaudeFixture(): void {
  const dir = join(projectsDir, '-tmp-digestproj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'digest-claude-1.jsonl'),
    jsonl([
      {
        type: 'user', uuid: 'u0', parentUuid: null, sessionId: 'digest-claude-1',
        timestamp: ts(0), cwd: CWD, isSidechain: false,
        message: { role: 'user', content: 'edit the file' },
      },
      {
        type: 'assistant', uuid: 'a1', parentUuid: 'u0', sessionId: 'digest-claude-1',
        timestamp: ts(1), cwd: CWD, isSidechain: false,
        message: {
          role: 'assistant', model: 'claude-opus-4-8', id: 'msg_d1',
          content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {
            file_path: `${CWD}/src/app.ts`, old_string: 'one\ntwo', new_string: 'one\nTWO\nthree',
          } }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      },
      {
        type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: 'digest-claude-1',
        timestamp: ts(2), cwd: CWD, isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      },
      {
        type: 'user', uuid: 'u3', parentUuid: 'u2', sessionId: 'digest-claude-1',
        timestamp: ts(3), cwd: CWD, isSidechain: false,
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      },
    ]),
  );
}

const a2ux = (agentEvent: unknown, sec: number) => ({
  kind: 'SessionA2uxEvent',
  event: { state: 'IN_PROGRESS', agentEvent },
  timestampMs: Date.UTC(2026, 0, 1, 10, 0, sec),
});

/** Junie session with real token usage but no error signal. */
function writeJunieFixture(): void {
  const id = 'session-260101-100000-digest';
  const dir = join(junieDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(junieDir, 'index.jsonl'),
    jsonl([
      {
        sessionId: id,
        createdAt: Date.UTC(2026, 0, 1, 10, 0, 0),
        updatedAt: Date.UTC(2026, 0, 1, 10, 0, 9),
        projectDir: '/tmp/junie-digestproj',
        taskName: 'junie digest fixture',
      },
    ]),
  );
  writeFileSync(
    join(dir, 'events.jsonl'),
    jsonl([
      { kind: 'UserPromptEvent', prompt: 'poke around' },
      { kind: 'SendToAgentEvent' },
      a2ux(
        {
          kind: 'LlmResponseMetadataEvent',
          modelUsage: [
            { model: 'claude-haiku-4-5-20251001', cost: 0.001, inputTokens: 500, cacheInputTokens: 0, cacheCreateTokens: 0, outputTokens: 100, time: 0 },
          ],
        },
        1,
      ),
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 's1', status: 'IN_PROGRESS', command: 'ls' }, 2),
      a2ux({ kind: 'TerminalBlockUpdatedEvent', stepId: 's1', status: 'COMPLETED', details: 'a.txt' }, 3),
    ]),
  );
}

let app: FastifyInstance | undefined;

beforeAll(async () => {
  writeClaudeFixture();
  writeJunieFixture();

  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  const { reindex } = await import('../src/data/index.js');

  app = Fastify();
  await registerRoutes(app);
  await reindex();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  const { closeConnection } = await import('../src/db/duckdb.js');
  await closeConnection();
  rmSync(work, { recursive: true, force: true });
});

async function fetchDigest(query = ''): Promise<DigestResponse> {
  const res = await app!.inject({ method: 'GET', url: `/api/analytics/digest${query}` });
  expect(res.statusCode).toBe(200);
  return res.json() as DigestResponse;
}

const RANGE = '?from=2026-01-01T00:00:00.000Z&to=2026-01-01T23:59:59.999Z';

describe('/api/analytics/digest', () => {
  it('composes totals across agents without zeroing on a no-signal agent', async () => {
    const d = await fetchDigest(RANGE);
    expect(d.totals.sessions).toBe(2);
    expect(d.totals.activeProjects).toBe(2);
    expect(d.totals.totalTokens).toBeGreaterThan(0);
    expect(d.totals.costUsd).toBeGreaterThan(0);
    expect(d.agents.map((a) => a.key).sort()).toEqual(['claude-code', 'junie']);
    // Reliability: Claude reports (0 errors of 1 call), Junie is listed as
    // no-signal — not zero-counted.
    expect(d.errors).not.toBeNull();
    expect(d.errors!.toolErrors).toBe(0);
    expect(d.errors!.toolCalls).toBe(1);
    expect(d.errors!.unknownAgents).toEqual(['junie']);
    expect(d.interrupts).toBe(1);
  });

  it('reports code impact from canonical file_edits', async () => {
    const d = await fetchDigest(RANGE);
    expect(d.impact.edits).toBe(1);
    expect(d.impact.additions).toBe(2);
    expect(d.impact.deletions).toBe(1);
    expect(d.impact.topFiles).toEqual([
      { path: `${CWD}/src/app.ts`, additions: 2, deletions: 1 },
    ]);
    expect(d.biggestSession).not.toBeNull();
    expect(d.biggestSession!.id).toBe('digest-claude-1');
  });

  it('returns a coherent empty digest for an empty range (no NaNs)', async () => {
    const d = await fetchDigest('?from=2030-01-01T00:00:00.000Z&to=2030-01-02T00:00:00.000Z');
    expect(d.totals.sessions).toBe(0);
    expect(d.totals.costUsd).toBe(0);
    expect(d.topProjects).toEqual([]);
    expect(d.models).toEqual([]);
    expect(d.topTools).toEqual([]);
    expect(d.biggestSession).toBeNull();
    expect(d.errors).toBeNull();
    expect(d.interrupts).toBeNull();
    expect(d.impact.edits).toBe(0);
    // JSON round-trip would have turned a NaN into null — assert numbers stayed numbers.
    expect(Number.isFinite(d.totals.totalTokens)).toBe(true);
    expect(Number.isFinite(d.impact.additions)).toBe(true);
  });
});
