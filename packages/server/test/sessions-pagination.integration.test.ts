/**
 * Fitness function: the sessions list pages correctly.
 *
 * The rule this file encodes is **paging is stable under ties**. Sort keys on
 * the sessions list are session-level aggregates (timestamps, tokens, cost,
 * message counts, context size), and real fixtures tie on all of them —
 * identical short sessions, replays of the same prompt, a whole afternoon of
 * runs stamped in the same second. Without a total order, `LIMIT`/`OFFSET` is
 * free to return the same row on two pages and never return another, so a
 * "Load more" walk would silently drop sessions. The fixture is built to tie
 * deliberately (48 of 52 sessions are identical on every sort key) so a missing
 * `, id` tie-break shows up as duplicated or skipped ids, not as a flake.
 *
 * It also pins the paging contract itself: the `X-Total-Count` header carries
 * the unpaged match count, an absent `limit` never returns more than the
 * default page, and `q` matches the same haystack the web filter used to apply
 * client-side (title, branch, id, model) — NULL-safely, so a session with no
 * recorded branch can still be found by its title.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionSort } from '@claudescope/shared';
import { SESSIONS_TOTAL_HEADER } from '@claudescope/shared';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-paging-'));
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

const CWD = '/tmp/pagingProj';
const TIED_COUNT = 48;
const TOTAL = TIED_COUNT + 4;

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

interface Fixture {
  id: string;
  title: string;
  branch?: string;
  model: string;
  /** Start of the session; each turn is +5s. */
  startedAt: string;
  usage: { input_tokens: number; output_tokens: number };
  /** User/assistant pairs written into the file. */
  turns: number;
}

function writeSession(f: Fixture): void {
  const base: Record<string, unknown> = { sessionId: f.id, cwd: CWD, version: '2.1.0' };
  if (f.branch !== undefined) base.gitBranch = f.branch;
  const start = Date.parse(f.startedAt);
  const at = (n: number): string => new Date(start + n * 5000).toISOString();

  const rows: unknown[] = [{ type: 'ai-title', sessionId: f.id, aiTitle: f.title }];
  for (let t = 0; t < f.turns; t++) {
    rows.push({
      ...base,
      type: 'user',
      uuid: `${f.id}-u${t}`,
      parentUuid: t === 0 ? null : `${f.id}-a${t - 1}`,
      timestamp: at(t * 2),
      isSidechain: false,
      message: { role: 'user', content: `turn ${t}` },
    });
    rows.push({
      ...base,
      type: 'assistant',
      uuid: `${f.id}-a${t}`,
      parentUuid: `${f.id}-u${t}`,
      timestamp: at(t * 2 + 1),
      isSidechain: false,
      message: {
        role: 'assistant',
        model: f.model,
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          ...f.usage,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
    });
  }
  writeFileSync(join(projectsDir, 'enc-paging', `${f.id}.jsonl`), jsonl(rows));
}

/**
 * 48 sessions that tie on every sort key (same timestamps, usage, model and
 * message count) plus 4 deliberately distinct ones that carry the `q` probes:
 * a unique branch, a unique id token, a unique model, and — with NO recorded
 * branch — a unique title token.
 */
function writeFixtures(): void {
  mkdirSync(join(projectsDir, 'enc-paging'), { recursive: true });

  for (let i = 0; i < TIED_COUNT; i++) {
    const n = String(i).padStart(2, '0');
    writeSession({
      id: `sess-tied-${n}`,
      title: `Tied session ${n}`,
      branch: 'main',
      model: 'claude-opus-4-8',
      startedAt: '2026-05-01T10:00:00.000Z',
      usage: { input_tokens: 100, output_tokens: 50 },
      turns: 1,
    });
  }

  writeSession({
    id: 'sess-zebra-unique',
    title: 'Distinct alpha',
    branch: 'main',
    model: 'claude-opus-4-8',
    startedAt: '2026-05-02T10:00:00.000Z',
    usage: { input_tokens: 1000, output_tokens: 500 },
    turns: 2,
  });
  writeSession({
    id: 'sess-distinct-b',
    title: 'Distinct bravo',
    branch: 'feat/paging-probe',
    model: 'claude-sonnet-4-9',
    startedAt: '2026-05-03T10:00:00.000Z',
    usage: { input_tokens: 2000, output_tokens: 800 },
    turns: 3,
  });
  writeSession({
    id: 'sess-distinct-c',
    title: 'Distinct charlie',
    branch: 'main',
    model: 'claude-haiku-9-uniquemodel',
    startedAt: '2026-04-28T10:00:00.000Z',
    usage: { input_tokens: 300, output_tokens: 150 },
    turns: 4,
  });
  // No gitBranch at all: a NULL branch must not make the whole `q` OR chain
  // NULL and hide this row from a title match.
  writeSession({
    id: 'sess-distinct-d',
    title: 'Distinct delta nullbranch',
    model: 'claude-opus-4-8',
    startedAt: '2026-04-29T10:00:00.000Z',
    usage: { input_tokens: 5, output_tokens: 2 },
    turns: 5,
  });
}

let app: FastifyInstance;
let closeConnection: () => Promise<void>;

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

const get = (url: string) => app.inject({ method: 'GET', url });
const ids = (body: unknown): string[] => (body as { id: string }[]).map((s) => s.id);
const total = (res: { headers: Record<string, unknown> }): number =>
  Number(res.headers[SESSIONS_TOTAL_HEADER]);

const SORTS: SessionSort[] = ['recent', 'oldest', 'tokens', 'cost', 'messages', 'context'];

describe('sessions paging is stable under ties', () => {
  it.each(SORTS)('sort=%s: pages of 2 cover the unpaged list exactly once', async (sort) => {
    const unpaged = await get(`/api/sessions?sort=${sort}&limit=500`);
    const all = ids(unpaged.json());
    expect(all).toHaveLength(TOTAL);

    const walked: string[] = [];
    for (let offset = 0; offset < TOTAL + 4; offset += 2) {
      const res = await get(`/api/sessions?sort=${sort}&limit=2&offset=${offset}`);
      expect(res.statusCode).toBe(200);
      // Every page reports the same unpaged total.
      expect(total(res)).toBe(TOTAL);
      const page = ids(res.json());
      if (page.length === 0) break;
      walked.push(...page);
    }

    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual([...all].sort());
    // The order is total, so the walk reproduces the unpaged sequence exactly.
    expect(walked).toEqual(all);
  });
});

describe('X-Total-Count and the default page size', () => {
  it('an absent limit returns the default page, not the whole table', async () => {
    const res = await get('/api/sessions');
    expect(res.statusCode).toBe(200);
    expect(ids(res.json())).toHaveLength(50);
    expect(total(res)).toBe(TOTAL);
  });

  it('reports the filtered count when q or agent narrows', async () => {
    const filtered = await get('/api/sessions?q=nullbranch');
    expect(total(filtered)).toBe(1);
    const none = await get('/api/sessions?agent=codex');
    expect(ids(none.json())).toEqual([]);
    expect(total(none)).toBe(0);
    const all = await get('/api/sessions?agent=claude-code&limit=500');
    expect(total(all)).toBe(TOTAL);
  });
});

describe('q matches title, branch, id, or model', () => {
  it('finds a session by its git branch', async () => {
    const res = await get('/api/sessions?q=paging-probe');
    expect(ids(res.json())).toEqual(['sess-distinct-b']);
    expect(total(res)).toBe(1);
  });

  it('finds a session by a substring of its id', async () => {
    const res = await get('/api/sessions?q=zebra');
    expect(ids(res.json())).toEqual(['sess-zebra-unique']);
  });

  it('finds a session by model name', async () => {
    const res = await get('/api/sessions?q=uniquemodel');
    expect(ids(res.json())).toEqual(['sess-distinct-c']);
  });

  it('a NULL branch does not hide a title match', async () => {
    const res = await get('/api/sessions?q=nullbranch');
    expect(ids(res.json())).toEqual(['sess-distinct-d']);
  });

  it('no match returns an empty page and a zero total', async () => {
    const res = await get('/api/sessions?q=no-such-token-anywhere');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(total(res)).toBe(0);
  });
});

describe('malformed paging params clamp instead of erroring', () => {
  it('a bogus limit falls back to the default page', async () => {
    const res = await get('/api/sessions?limit=abc');
    expect(res.statusCode).toBe(200);
    expect(ids(res.json())).toHaveLength(50);
    expect(total(res)).toBe(TOTAL);
  });

  it('limit=0 clamps to the minimum page rather than returning everything', async () => {
    const res = await get('/api/sessions?limit=0');
    expect(res.statusCode).toBe(200);
    expect(ids(res.json())).toHaveLength(1);
  });

  it.each(['-1', 'abc'])('offset=%s is treated as the first page', async (bad) => {
    const res = await get(`/api/sessions?limit=3&offset=${bad}`);
    expect(res.statusCode).toBe(200);
    const first = await get('/api/sessions?limit=3');
    expect(ids(res.json())).toEqual(ids(first.json()));
  });
});
