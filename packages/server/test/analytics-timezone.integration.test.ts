/**
 * Timezone-aware analytics integration edges. The fixture straddles both 2026
 * Europe/Amsterdam DST transitions so a fixed offset cannot satisfy these
 * assertions: the spring day is 23 hours, and the fall overlap contains two
 * distinct UTC instants with the same local wall-clock hour.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const work = mkdtempSync(join(tmpdir(), 'claudescope-timezone-'));
const projectsDir = join(work, 'projects');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
for (const variable of [
  'CODEX_SESSIONS_DIR',
  'JUNIE_SESSIONS_DIR',
  'PI_SESSIONS_DIR',
  'OPENCODE_DATA_DIR',
  'COPILOT_SESSIONS_DIR',
  'ANTIGRAVITY_CLI_DIR',
  'ANTIGRAVITY_DIR',
  'GROK_SESSIONS_DIR',
]) {
  process.env[variable] = join(work, `${variable.toLowerCase()}-empty`);
}
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const CWD = '/tmp/timezone-analytics';
const ZONE = 'Europe/Amsterdam';

const fixtures = [
  { id: 'spring-before', timestamp: '2026-03-28T22:59:00.000Z', input: 1 },
  { id: 'spring-start', timestamp: '2026-03-28T23:00:00.000Z', input: 2 },
  { id: 'spring-end', timestamp: '2026-03-29T21:59:00.000Z', input: 4 },
  { id: 'spring-after', timestamp: '2026-03-29T22:00:00.000Z', input: 8 },
  { id: 'fall-first', timestamp: '2026-10-25T00:30:00.000Z', input: 16 },
  { id: 'fall-second', timestamp: '2026-10-25T01:30:00.000Z', input: 32 },
] as const;

function writeFixtures(): void {
  const project = join(projectsDir, 'enc-timezone');
  mkdirSync(project, { recursive: true });

  for (const fixture of fixtures) {
    const base = {
      sessionId: fixture.id,
      cwd: CWD,
      gitBranch: 'main',
      timestamp: fixture.timestamp,
      isSidechain: false,
    };
    const rows = [
      {
        ...base,
        type: 'user',
        uuid: `${fixture.id}-user`,
        parentUuid: null,
        message: { role: 'user', content: fixture.id },
      },
      {
        ...base,
        type: 'assistant',
        uuid: `${fixture.id}-assistant`,
        parentUuid: `${fixture.id}-user`,
        message: {
          role: 'assistant',
          id: `message-${fixture.id}`,
          model: 'claude-opus-4-8',
          content: [
            {
              type: 'tool_use',
              id: `tool-${fixture.id}`,
              name: 'Edit',
              input: {
                file_path: `${CWD}/${fixture.id}.txt`,
                old_string: fixture.id,
                new_string: `${fixture.id}-changed`,
              },
            },
          ],
          usage: { input_tokens: fixture.input, output_tokens: 1 },
        },
      },
    ];
    writeFileSync(
      join(project, `${fixture.id}.jsonl`),
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
  }
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
const zone = `timeZone=${encodeURIComponent(ZONE)}`;

describe('timezone-aware analytics', () => {
  it('groups the same UTC instants into local IANA calendar days', async () => {
    const utc = await get('/api/analytics?groupBy=day');
    expect(utc.statusCode).toBe(200);
    expect(utc.json().rows.map((row: { key: string }) => row.key).sort()).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-10-25',
    ]);

    const local = await get(`/api/analytics?groupBy=day&${zone}`);
    expect(local.statusCode).toBe(200);
    expect(local.json().rows.map((row: { key: string }) => row.key).sort()).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-10-25',
    ]);
  });

  it('uses local midnights for a date-only range across spring-forward', async () => {
    const res = await get(
      `/api/analytics?groupBy=day&from=2026-03-29&to=2026-03-29&${zone}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toHaveLength(1);
    expect(res.json().rows[0]).toMatchObject({ key: '2026-03-29', inputTokens: 6 });
    expect(res.json().totals.messageCount).toBe(2);

    const digest = await get(
      `/api/analytics/digest?from=2026-03-29&to=2026-03-29&${zone}`,
    );
    expect(digest.statusCode).toBe(200);
    expect(digest.json().totals.sessions).toBe(2);
    expect(digest.json().totals.totalTokens).toBe(8);
  });

  it('preserves a numeric-offset timestamp as an exact instant', async () => {
    const instant = encodeURIComponent('2026-03-29T01:00:00+02:00');
    const res = await get(`/api/analytics?groupBy=day&from=${instant}&to=${instant}&${zone}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toHaveLength(1);
    expect(res.json().rows[0]).toMatchObject({ key: '2026-03-29', inputTokens: 2 });
    expect(res.json().totals.messageCount).toBe(1);
  });

  it('buckets both fall-back instants into the repeated local hour', async () => {
    const res = await get(
      `/api/analytics/activity?from=2026-10-25&to=2026-10-25&${zone}&today=2026-10-25`,
    );
    expect(res.statusCode).toBe(200);
    const hourTwo = res
      .json()
      .heatmap.filter((cell: { hour: number }) => cell.hour === 2)
      .reduce((count: number, cell: { count: number }) => count + cell.count, 0);
    expect(hourTwo).toBe(2);
  });

  it('uses the timezone for code-impact day grouping', async () => {
    const res = await get(
      `/api/analytics/impact?groupBy=day&from=2026-03-29&to=2026-03-29&${zone}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toHaveLength(1);
    expect(res.json().rows[0]).toMatchObject({ key: '2026-03-29', edits: 2 });
  });

  it('retains the fixed-offset activity fallback for existing callers', async () => {
    const instant = encodeURIComponent('2026-03-28T23:00:00.000Z');
    const res = await get(
      `/api/analytics/activity?from=${instant}&to=${instant}&tzOffsetMinutes=120&today=2026-03-29`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().heatmap).toEqual([{ dow: 7, hour: 1, count: 1 }]);
  });
});

describe('timezone validation', () => {
  const boundedEndpoints = [
    '/api/analytics',
    '/api/analytics/sessions',
    '/api/analytics/agents',
    '/api/analytics/activity',
    '/api/analytics/tools',
    '/api/analytics/impact',
    '/api/analytics/errors',
    '/api/analytics/digest',
  ];

  it.each(boundedEndpoints)('%s rejects an unknown IANA timezone', async (path) => {
    const res = await get(`${path}?timeZone=Mars%2FOlympus`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^timeZone must be a recognized IANA timezone/);
    expect(res.body).not.toMatch(/SELECT|pg_timezone_names|Catalog Error/i);
  });
});
