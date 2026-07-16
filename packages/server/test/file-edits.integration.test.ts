/**
 * `file_edits` extraction + code-impact analytics integration tests — the
 * bug-prone domain edges, per the repo test doctrine:
 *
 *  1. Fork dedup — forking a Claude session copies the whole history (uuids and
 *     tool_use ids preserved, `forkedFrom` marker set). Both sessions' edits
 *     land in `file_edits`, but only the ORIGINAL's rows are `edit_canonical`,
 *     so /api/analytics/impact counts each edit once.
 *  2. Codex apply_patch fan-out — one `custom_tool_call` touching N files fans
 *     out to canonical Write/MultiEdit blocks per file; each must land as its
 *     own row with exact LCS add/del counts.
 *  3. `tool_error_count` — Claude Code counts `is_error` tool_results in SQL
 *     (0 when none); Codex counts in TS at normalize time.
 *  4. Incremental correctness — editing a source file re-extracts its session's
 *     rows (clean replace, no duplicates); deleting the original re-elects the
 *     surviving fork copy.
 *
 * (Junie's full-file-diff counts and NULL tool_error_count, and Copilot's
 * denied-edit exclusion, are asserted in their own connector suites, which
 * already carry those fixtures.)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DuckDBConnection } from '@duckdb/node-api';

const work = mkdtempSync(join(tmpdir(), 'claudescope-fedits-'));
const projectsDir = join(work, 'projects');
const codexDir = join(work, 'codex');
const junieDir = join(work, 'junie');
const copilotDir = join(work, 'copilot');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = codexDir;
process.env.JUNIE_SESSIONS_DIR = junieDir;
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = copilotDir;
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ts = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;

const CWD = '/tmp/feditsproj';

/** An assistant line carrying tool_use blocks (Claude transcript shape). */
function asst(opts: {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  blocks: unknown[];
  forkedFrom?: { sessionId: string; messageUuid: string };
}): Record<string, unknown> {
  const line: Record<string, unknown> = {
    type: 'assistant',
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp,
    cwd: CWD,
    isSidechain: false,
    message: { role: 'assistant', model: 'claude-opus-4-8', content: opts.blocks },
  };
  if (opts.forkedFrom) line.forkedFrom = opts.forkedFrom;
  return line;
}

/** A user line whose content is tool_result blocks (or plain text). */
function user(opts: {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  content: unknown;
  forkedFrom?: { sessionId: string; messageUuid: string };
}): Record<string, unknown> {
  const line: Record<string, unknown> = {
    type: 'user',
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp,
    cwd: CWD,
    isSidechain: false,
    message: { role: 'user', content: opts.content },
  };
  if (opts.forkedFrom) line.forkedFrom = opts.forkedFrom;
  return line;
}

/**
 * The original Claude session: one Edit (2 adds / 1 del), a failing Bash
 * (is_error tool_result), and one Write (3 adds). The fork copy repeats the
 * same lines under a new session id with `forkedFrom` markers.
 */
function claudeLines(sessionId: string, forkedFrom?: string): unknown[] {
  const fork = forkedFrom
    ? (uuid: string) => ({ forkedFrom: { sessionId: forkedFrom, messageUuid: uuid } })
    : () => ({});
  return [
    user({ uuid: 'u0', parentUuid: null, sessionId, timestamp: ts(0), content: 'fix the bug', ...fork('u0') }),
    asst({
      uuid: 'a1', parentUuid: 'u0', sessionId, timestamp: ts(1), ...fork('a1'),
      blocks: [
        { type: 'tool_use', id: 'toolu_edit1', name: 'Edit', input: {
          file_path: `${CWD}/src/app.ts`, old_string: 'one\ntwo', new_string: 'one\nTWO\nthree',
        } },
      ],
    }),
    user({
      uuid: 'u2', parentUuid: 'a1', sessionId, timestamp: ts(2), ...fork('u2'),
      content: [{ type: 'tool_result', tool_use_id: 'toolu_edit1', content: 'ok' }],
    }),
    asst({
      uuid: 'a3', parentUuid: 'u2', sessionId, timestamp: ts(3), ...fork('a3'),
      blocks: [{ type: 'tool_use', id: 'toolu_bash1', name: 'Bash', input: { command: 'npm test' } }],
    }),
    user({
      uuid: 'u4', parentUuid: 'a3', sessionId, timestamp: ts(4), ...fork('u4'),
      content: [{ type: 'tool_result', tool_use_id: 'toolu_bash1', content: '1 test failed', is_error: true }],
    }),
    asst({
      uuid: 'a5', parentUuid: 'u4', sessionId, timestamp: ts(5), ...fork('a5'),
      blocks: [
        { type: 'tool_use', id: 'toolu_write1', name: 'Write', input: {
          file_path: `${CWD}/notes.md`, content: 'alpha\nbeta\ngamma',
        } },
      ],
    }),
  ];
}

function writeFixtures(): void {
  const proj = join(projectsDir, 'enc-fedits');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'sessOrig.jsonl'), jsonl(claudeLines('sessOrig')));
  writeFileSync(join(proj, 'sessFork.jsonl'), jsonl(claudeLines('sessFork', 'sessOrig')));

  // Codex rollout: one apply_patch fanning out to TWO files (Add + Update) and
  // a second single-file patch — per-file rows with exact counts.
  const dir = join(codexDir, '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'rollout-2026-01-01T10-00-00-019db3da-f840-7142-a548-5bd30f5fe572.jsonl'),
    jsonl([
      { type: 'session_meta', timestamp: ts(0), payload: { id: 'codex-fe-1', cwd: '/tmp/codexfe', cli_version: '0.122.0', model_provider: 'openai', git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(1), payload: { model: 'gpt-5.4', cwd: '/tmp/codexfe' } },
      { type: 'response_item', timestamp: ts(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'patch things' }] } },
      { type: 'response_item', timestamp: ts(3), payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_ap1', input: '*** Begin Patch\n*** Add File: /tmp/codexfe/notes.md\n+hello\n+world\n*** Update File: /tmp/codexfe/src/app.ts\n@@\n context line\n-old value\n+new value\n*** End Patch' } },
      { type: 'response_item', timestamp: ts(4), payload: { type: 'custom_tool_call_output', call_id: 'call_ap1', output: 'Done!' } },
      { type: 'response_item', timestamp: ts(5), payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_ap2', input: '*** Begin Patch\n*** Update File: /tmp/codexfe/single.ts\n@@\n-a\n+b\n*** End Patch' } },
      { type: 'response_item', timestamp: ts(6), payload: { type: 'custom_tool_call_output', call_id: 'call_ap2', output: 'Done!' } },
      { type: 'response_item', timestamp: ts(7), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'patched' }] } },
    ]),
  );

  // Junie: stores the FULL before/after file per change — the extraction must
  // record the exact one-line diff, not whole-file counts.
  const JUNIE_ID = 'session-260101-100000-fedits';
  const a2ux = (agentEvent: unknown, sec: number) => ({
    kind: 'SessionA2uxEvent',
    event: { state: 'IN_PROGRESS', agentEvent },
    timestampMs: Date.UTC(2026, 0, 1, 10, 0, sec),
  });
  const before = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const after = before.replace('line 5', 'line five');
  mkdirSync(join(junieDir, JUNIE_ID), { recursive: true });
  writeFileSync(
    join(junieDir, 'index.jsonl'),
    jsonl([{ sessionId: JUNIE_ID, createdAt: Date.UTC(2026, 0, 1, 10, 0, 0), updatedAt: Date.UTC(2026, 0, 1, 10, 0, 9), projectDir: '/tmp/junfe', taskName: 'edit a file' }]),
  );
  writeFileSync(
    join(junieDir, JUNIE_ID, 'events.jsonl'),
    jsonl([
      { kind: 'UserPromptEvent', prompt: 'change line 5' },
      a2ux({
        kind: 'FileChangesBlockUpdatedEvent',
        stepId: 'step-E',
        status: 'COMPLETED',
        changes: [{
          beforeContent: { kind: 'TextFileContent', text: before },
          afterContent: { kind: 'TextFileContent', text: after },
          beforeRelativePath: 'src/big.ts',
          afterRelativePath: 'src/big.ts',
        }],
      }, 3),
      { kind: 'TaskState', state: 'COMPLETED', timestampMs: Date.UTC(2026, 0, 1, 10, 0, 9) },
    ]),
  );

  // Copilot: a successful edit lands; a DENIED edit stays under its raw name
  // (only-successful-edits normalization rule) and must NOT produce a row.
  let evtId = 0;
  const cev = (type: string, data: unknown) => ({ type, data, id: `e${evtId++}`, timestamp: ts(evtId), parentId: null });
  mkdirSync(join(copilotDir, 'cfe'), { recursive: true });
  writeFileSync(
    join(copilotDir, 'cfe', 'workspace.yaml'),
    'id: cfe\ncwd: /tmp/cpfe\nbranch: main\nname: fedits\nuser_named: false\n',
  );
  writeFileSync(
    join(copilotDir, 'cfe', 'events.jsonl'),
    jsonl([
      cev('session.start', { sessionId: 'copilot-fe-1', context: { cwd: '/tmp/cpfe', branch: 'main' } }),
      cev('user.message', { content: 'edit both files' }),
      cev('assistant.message', {
        messageId: 'm1', model: 'gpt-5-mini', content: 'editing',
        toolRequests: [
          { toolCallId: 'c-ok', name: 'edit', arguments: { path: '/tmp/cpfe/ok.ts', old_str: 'a', new_str: 'b' } },
          { toolCallId: 'c-deny', name: 'edit', arguments: { path: '/tmp/cpfe/deny.ts', old_str: 'x', new_str: 'y' } },
        ],
      }),
      cev('tool.execution_complete', { toolCallId: 'c-ok', success: true, result: { content: 'File ok.ts updated.' } }),
      cev('permission.requested', { requestId: 'r1', permissionRequest: { kind: 'write', toolCallId: 'c-deny', fileName: '/tmp/cpfe/deny.ts' } }),
      cev('permission.completed', { requestId: 'r1', toolCallId: 'c-deny', result: { kind: 'denied-interactively-by-user' } }),
      cev('session.shutdown', { tokenDetails: { input: { tokenCount: 10 }, output: { tokenCount: 5 } } }),
    ]),
  );
}

let app: FastifyInstance;
let conn: DuckDBConnection;
let closeConnection: () => Promise<void>;
let reindex: () => Promise<unknown>;
let queryRows: (c: DuckDBConnection, sql: string) => Promise<Record<string, unknown>[]>;

beforeAll(async () => {
  writeFixtures();

  const Fastify = (await import('fastify')).default;
  const { registerRoutes } = await import('../src/routes/index.js');
  ({ reindex } = await import('../src/data/index.js'));
  const duckdb = await import('../src/db/duckdb.js');
  ({ closeConnection, queryRows } = duckdb);

  app = Fastify();
  await registerRoutes(app);
  await reindex();
  await app.ready();
  conn = await duckdb.getConnection();
});

afterAll(async () => {
  await app?.close();
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

const get = async (url: string) => app.inject({ method: 'GET', url });

describe('file_edits extraction', () => {
  it('fans Codex apply_patch out to per-file rows with exact LCS counts', async () => {
    const rows = await queryRows(
      conn,
      `SELECT file_path, tool_name, additions, deletions FROM file_edits
       WHERE session_id = 'codex-fe-1' ORDER BY file_path`,
    );
    expect(
      rows.map((r) => [r.file_path, r.tool_name, Number(r.additions), Number(r.deletions)]),
    ).toEqual([
      ['/tmp/codexfe/notes.md', 'Write', 2, 0],
      ['/tmp/codexfe/single.ts', expect.stringMatching(/Edit/), 1, 1],
      ['/tmp/codexfe/src/app.ts', expect.stringMatching(/Edit/), 1, 1],
    ]);
  });

  it('keeps fork copies but elects only the original session canonical', async () => {
    const rows = await queryRows(
      conn,
      `SELECT session_id, file_path, edit_canonical FROM file_edits
       WHERE session_id IN ('sessOrig', 'sessFork') ORDER BY session_id, file_path`,
    );
    // Both sessions carry both edits (2 each)…
    expect(rows).toHaveLength(4);
    // …but only the original's are canonical.
    for (const r of rows) {
      expect(Boolean(r.edit_canonical)).toBe(r.session_id === 'sessOrig');
    }
  });

  it('records Junie full-file before/after as the exact diff, not whole-file counts', async () => {
    const rows = await queryRows(
      conn,
      `SELECT file_path, additions, deletions FROM file_edits
       WHERE session_id = 'session-260101-100000-fedits'`,
    );
    expect(rows.map((r) => [r.file_path, Number(r.additions), Number(r.deletions)])).toEqual([
      ['src/big.ts', 1, 1], // one changed line in a 10-line file
    ]);
  });

  it('excludes Copilot denied edits (only successful edits are canonical)', async () => {
    const rows = await queryRows(
      conn,
      `SELECT file_path FROM file_edits WHERE session_id = 'copilot-fe-1'`,
    );
    expect(rows.map((r) => r.file_path)).toEqual(['/tmp/cpfe/ok.ts']);
  });

  it('leaves tool_error_count NULL for Junie (no error signal in the format)', async () => {
    const rows = await queryRows(
      conn,
      `SELECT count(*) AS total, count(*) FILTER (WHERE tool_error_count IS NULL) AS nulls
       FROM events WHERE session_id = 'session-260101-100000-fedits'`,
    );
    expect(Number(rows[0]!.total)).toBeGreaterThan(0);
    expect(Number(rows[0]!.nulls)).toBe(Number(rows[0]!.total));
  });

  it('counts is_error tool_results for Claude (SQL) and Codex (TS) — never NULL', async () => {
    const claude = await queryRows(
      conn,
      `SELECT COALESCE(sum(tool_error_count), 0) AS errs,
              count(*) FILTER (WHERE tool_error_count IS NULL) AS nulls
       FROM events WHERE session_id = 'sessOrig'`,
    );
    expect(Number(claude[0]!.errs)).toBe(1); // the failing Bash
    expect(Number(claude[0]!.nulls)).toBe(0);

    const codex = await queryRows(
      conn,
      `SELECT count(*) FILTER (WHERE tool_error_count IS NULL) AS nulls
       FROM events WHERE session_id = 'codex-fe-1'`,
    );
    expect(Number(codex[0]!.nulls)).toBe(0);
  });
});

describe('GET /api/analytics/impact', () => {
  it('counts forked edits once and groups by agent', async () => {
    const res = await get('/api/analytics/impact?groupBy=agent');
    if (res.statusCode !== 200) console.error('impact route error:', res.body);
    const body = res.json();
    const claude = body.rows.find((r: { key: string }) => r.key === 'claude-code');
    // Only sessOrig's rows count: Edit (+2/−1) + Write (+3/−0).
    expect(claude).toMatchObject({ additions: 5, deletions: 1, edits: 2, filesTouched: 2, sessions: 1 });
    const codex = body.rows.find((r: { key: string }) => r.key === 'codex');
    expect(codex).toMatchObject({ additions: 4, deletions: 2, edits: 3, filesTouched: 3, sessions: 1 });
    // claude 5/1 + codex 4/2 + junie 1/1 + copilot 1/1, forked copies excluded.
    expect(body.totals).toMatchObject({ additions: 11, deletions: 5, edits: 7, filesTouched: 7 });
  });

  it('filters by project and groups by file and day', async () => {
    const { projectIdFromCwd } = await import('../src/data/project-id.js');
    const byFile = (
      await get(`/api/analytics/impact?groupBy=file&project=${projectIdFromCwd(CWD)}`)
    ).json();
    expect(byFile.rows.map((r: { key: string }) => r.key).sort()).toEqual([
      `${CWD}/notes.md`,
      `${CWD}/src/app.ts`,
    ]);

    const byDay = (await get('/api/analytics/impact?groupBy=day')).json();
    expect(byDay.rows).toHaveLength(1);
    expect(byDay.rows[0]).toMatchObject({ key: '2026-01-01', additions: 11, deletions: 5 });
  });
});

describe('incremental re-extraction', () => {
  it('replaces a changed session cleanly and re-elects after the original is deleted', async () => {
    // Append another Write to the FORK file: its session re-extracts (no dupes),
    // and the new (un-forked) edit is canonical because only the fork has it.
    const proj = join(projectsDir, 'enc-fedits');
    const extra = asst({
      uuid: 'a9', parentUuid: 'a5', sessionId: 'sessFork', timestamp: ts(9),
      blocks: [
        { type: 'tool_use', id: 'toolu_write9', name: 'Write', input: {
          file_path: `${CWD}/fresh.ts`, content: 'x',
        } },
      ],
    });
    writeFileSync(
      join(proj, 'sessFork.jsonl'),
      jsonl([...claudeLines('sessFork', 'sessOrig'), extra]),
    );
    await reindex();

    const fork = await queryRows(
      conn,
      `SELECT file_path, edit_canonical FROM file_edits WHERE session_id = 'sessFork' ORDER BY file_path`,
    );
    expect(fork).toHaveLength(3); // clean replace: 2 copied + 1 new, no dupes
    expect(fork.filter((r) => Boolean(r.edit_canonical)).map((r) => r.file_path)).toEqual([
      `${CWD}/fresh.ts`,
    ]);

    // Delete the original file: the fork's copies must be re-elected canonical
    // (the impact numbers re-attach to the surviving session).
    rmSync(join(proj, 'sessOrig.jsonl'));
    await reindex();
    const after = await queryRows(
      conn,
      `SELECT session_id, count(*) FILTER (WHERE edit_canonical) AS canon
       FROM file_edits GROUP BY session_id ORDER BY session_id`,
    );
    expect(after.find((r) => r.session_id === 'sessOrig')).toBeUndefined();
    expect(Number(after.find((r) => r.session_id === 'sessFork')?.canon)).toBe(3);
  });
});
