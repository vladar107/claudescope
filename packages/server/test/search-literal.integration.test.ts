/**
 * `GET /api/search?literal=true` — exact substring search.
 *
 * The BM25 path answers a different question than an agent asking "have I seen
 * THIS string before?": it tokenizes, so punctuation-heavy error messages and
 * identifiers dissolve into common words, and it only ever looks at
 * `events.text_content` — a tool failure the assistant never restated in prose
 * is not in the index it searches at all. The literal branch therefore also
 * covers `tool_error_text`, `tool_names` and `skill_names`, and interpolates the
 * query into SQL, so the quoting has to survive a string full of quotes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-searchlit-'));
const projectsDir = join(work, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
for (const v of [
  'CODEX_SESSIONS_DIR',
  'JUNIE_SESSIONS_DIR',
  'PI_SESSIONS_DIR',
  'OPENCODE_DATA_DIR',
  'COPILOT_SESSIONS_DIR',
  'ANTIGRAVITY_CLI_DIR',
  'ANTIGRAVITY_DIR',
  'GROK_SESSIONS_DIR',
]) {
  process.env[v] = join(work, `${v.toLowerCase()}-empty`);
}
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

/** Assistant prose carrying an error verbatim — quotes, colons and all. */
const ENOENT = `Error: ENOENT: no such file or directory, open '/tmp/x.json'`;
/** Body of a failed tool_result; no assistant message repeats it. */
const LOCK_ERROR =
  'IO Error: Could not set lock on file "/tmp/lit/index.duckdb": Conflicting lock is held';

function writeFixtures(): void {
  const proj = join(projectsDir, 'enc-lit');
  mkdirSync(proj, { recursive: true });
  const base = { sessionId: 'sLit', cwd: '/tmp/lit', gitBranch: 'main', version: '2.1.0' };

  const rows = [
    {
      ...base,
      type: 'user',
      uuid: 'u-go',
      parentUuid: null,
      timestamp: '2026-05-02T09:00:00.000Z',
      isSidechain: false,
      message: { role: 'user', content: 'rebuild the index' },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a-enoent',
      parentUuid: 'u-go',
      timestamp: '2026-05-02T09:00:01.000Z',
      isSidechain: false,
      message: {
        role: 'assistant',
        id: 'm1',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: `The rebuild failed: ${ENOENT} — retrying once.` }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      // Only the failed result carries the message: no text/thinking block, so
      // this row has no text_content and cannot be found by the BM25 path.
      ...base,
      type: 'user',
      uuid: 'u-lock',
      parentUuid: 'a-enoent',
      timestamp: '2026-05-02T09:00:02.000Z',
      isSidechain: false,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: LOCK_ERROR }],
      },
    },
    {
      // The skill name lives in the call's input; tool_names only says "Skill"
      // and the prose never mentions it.
      ...base,
      type: 'assistant',
      uuid: 'a-skill',
      parentUuid: 'u-lock',
      timestamp: '2026-05-02T09:00:03.000Z',
      isSidechain: false,
      message: {
        role: 'assistant',
        id: 'm2',
        model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: 'Let me check what happened last time.' },
          { type: 'tool_use', id: 't2', name: 'Skill', input: { skill: 'claudescope:history' } },
        ],
        usage: { input_tokens: 8, output_tokens: 4 },
      },
    },
    {
      // `İ` (U+0130) lowercases to two code points in JavaScript and to one
      // in DuckDB, so lowering the needle on the JS side loses this row entirely.
      ...base,
      type: 'user',
      uuid: 'u-turkish',
      parentUuid: 'a-skill',
      timestamp: '2026-05-02T09:00:04.000Z',
      isSidechain: false,
      message: { role: 'user', content: 'Config for İnfo service' },
    },
  ];

  writeFileSync(join(proj, 'sLit.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

/** Run a search; `literal` and `type` are opt-in so the BM25 default is testable too. */
async function search(
  q: string,
  extra: Record<string, string> = {},
): Promise<{ messageUuid: string; role: string; snippet: string }[]> {
  const params = new URLSearchParams({ q, ...extra });
  const res = await app.inject({ method: 'GET', url: `/api/search?${params}` });
  expect(res.statusCode).toBe(200);
  return res.json().sessions;
}

beforeAll(async () => {
  writeFixtures();
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

describe('GET /api/search?literal=true', () => {
  it('matches a punctuated error string including its quotes', async () => {
    const hits = await search(ENOENT, { literal: 'true' });
    expect(hits.map((h) => h.messageUuid)).toEqual(['a-enoent']);
    expect(hits[0].snippet).toContain('<mark>');
  });

  it('reaches a failed tool_result the assistant never restated', async () => {
    const hits = await search('IO Error: Could not set lock on file', { literal: 'true' });
    expect(hits.map((h) => h.messageUuid)).toEqual(['u-lock']);
    expect(hits[0].role).toBe('user');
    expect(hits[0].snippet).toContain('Conflicting lock is held');
  });

  it('is the only path that finds it — the BM25 default cannot', async () => {
    const hits = await search('IO Error: Could not set lock on file');
    expect(hits.map((h) => h.messageUuid)).not.toContain('u-lock');
  });

  it('matches a Skill call by the skill it invoked, naming it in the snippet', async () => {
    const hits = await search('claudescope:history', { literal: 'true' });
    expect(hits.map((h) => h.messageUuid)).toEqual(['a-skill']);
    expect(hits[0].snippet).toBe('Skills: <mark>claudescope:history</mark>');
  });

  it('case-folds only in DuckDB, so a code point JS lowercases differently still hits', async () => {
    const hits = await search('for İnfo service', { literal: 'true' });
    expect(hits.map((h) => h.messageUuid)).toEqual(['u-turkish']);
    // Snippet drawn from the matched text, not the synthetic tool-name fallback.
    expect(hits[0].snippet).toBe('Config <mark>for İnfo service</mark>');
  });

  it('honors format=plain', async () => {
    const hits = await search(ENOENT, { literal: 'true', format: 'plain' });
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).not.toContain('<mark>');
    expect(hits[0].snippet).toContain(ENOENT);
  });

  it('honors the role filter — type=assistant drops the user-row error hit', async () => {
    const hits = await search('IO Error: Could not set lock on file', {
      literal: 'true',
      type: 'assistant',
    });
    expect(hits).toHaveLength(0);
  });
});
