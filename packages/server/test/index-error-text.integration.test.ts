/**
 * Schema v19's two derived columns, end to end.
 *
 * `tool_error_text` is the one derivation whose source shape is genuinely
 * polymorphic: `tool_result.content` is usually a string but can be an array of
 * blocks, and Claude Code derives the column in SQL (a DuckDB `json_type` switch)
 * while every other connector derives it in TypeScript — two implementations that
 * have to agree. `skill_names` reaches into `tool_use.input`, which nothing else
 * in the index does, so a Skill call without a `skill` argument must not poison it.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'claudescope-errtext-'));
const projectsDir = join(work, 'projects');
const codexDir = join(work, 'codex');
process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CODEX_SESSIONS_DIR = codexDir;
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

/** Longer than the 4000-char per-event cap. */
const HUGE = 'stack frame\n'.repeat(900);

let getConnection: typeof import('../src/db/duckdb.js').getConnection;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let closeConnection: typeof import('../src/db/duckdb.js').closeConnection;

const row = async (uuid: string): Promise<Record<string, unknown>> => {
  const conn = await getConnection();
  const rows = await queryRows(
    conn,
    `SELECT tool_error_count, tool_error_text, skill_names FROM events WHERE uuid = '${uuid}'`,
  );
  return rows[0]!;
};

beforeAll(async () => {
  const projA = join(projectsDir, 'enc-errtext');
  mkdirSync(projA, { recursive: true });
  const base = { sessionId: 'sErr', cwd: '/tmp/errtext', gitBranch: 'main', version: '2.1.0' };
  const at = (n: number) => `2026-06-02T10:00:${String(n).padStart(2, '0')}.000Z`;
  writeFileSync(
    join(projA, 'sErr.jsonl'),
    jsonl([
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: at(0), isSidechain: false, message: { role: 'user', content: 'build it' } },
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at(1), isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }], usage: { input_tokens: 5, output_tokens: 5 } } },
      // String-form failed result.
      { ...base, type: 'user', uuid: 'r1', parentUuid: 'a1', timestamp: at(2), isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'ENOENT: no such file or directory' }] } },
      // Array-form failed result: only the text item is searchable, the image is not.
      { ...base, type: 'user', uuid: 'r2', parentUuid: 'r1', timestamp: at(3), isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'TS2339: Property foo does not exist' }] }] } },
      // Successful result — must stay NULL, not ''.
      { ...base, type: 'user', uuid: 'r3', parentUuid: 'r2', timestamp: at(4), isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Build succeeded' }] } },
      // Oversized failure body.
      { ...base, type: 'user', uuid: 'r4', parentUuid: 'r3', timestamp: at(5), isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', is_error: true, content: HUGE }] } },
      { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'r4', timestamp: at(6), isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', id: 'm2', content: [
        { type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'claudescope:history' } },
        { type: 'tool_use', id: 's2', name: 'Skill', input: { command: 'no skill argument' } },
        { type: 'tool_use', id: 's3', name: 'Skill', input: { skill: '' } },
      ], usage: { input_tokens: 5, output_tokens: 5 } } },
    ]),
  );

  // Codex: the same column, derived by a normalizer and round-tripped through the
  // canonical NDJSON cache instead of read straight out of the source JSONL.
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, 'rollout-2026-06-02T10-00-00-019db3da-f840-7142-a548-5bd30f5fe573.jsonl'),
    jsonl([
      { type: 'session_meta', timestamp: at(0), payload: { id: 'codex-err-1', cwd: '/tmp/codexerr', cli_version: '0.122.0', model_provider: 'openai', git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: at(1), payload: { model: 'gpt-5.4', cwd: '/tmp/codexerr' } },
      { type: 'response_item', timestamp: at(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build it' }] } },
      { type: 'response_item', timestamp: at(3), payload: { type: 'custom_tool_call', name: 'exec', input: 'npm run build', call_id: 'c1' } },
      { type: 'response_item', timestamp: at(4), payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'bash: vitest: command not found', is_error: true } },
    ]),
  );

  ({ getConnection, queryRows, closeConnection } = await import('../src/db/duckdb.js'));
  const { reindex } = await import('../src/data/index.js');
  await reindex();
});

afterAll(async () => {
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('tool_error_text indexing', () => {
  it('indexes a string-form failed result verbatim', async () => {
    expect((await row('r1')).tool_error_text).toBe('ENOENT: no such file or directory');
  });

  it('keeps only the text items of an array-form failed result', async () => {
    expect((await row('r2')).tool_error_text).toBe('TS2339: Property foo does not exist');
  });

  it('leaves a successful result NULL (distinct from an empty body)', async () => {
    const r3 = await row('r3');
    expect(r3.tool_error_text).toBeNull();
    expect(Number(r3.tool_error_count)).toBe(0);
  });

  it('caps an oversized failure body per event', async () => {
    expect((await row('r4')).tool_error_text).toBe(HUGE.slice(0, 4000));
  });

  it('survives the canonical NDJSON round trip (Codex)', async () => {
    const conn = await getConnection();
    const rows = await queryRows(
      conn,
      `SELECT tool_error_text, skill_names FROM events
       WHERE session_id = 'codex-err-1' AND tool_error_text IS NOT NULL`,
    );
    expect(rows.map((r) => r.tool_error_text)).toEqual(['bash: vitest: command not found']);
    expect(rows[0]?.skill_names).toBe('');
  });
});

describe('skill_names indexing', () => {
  it('records the skill argument and skips a Skill call with none or an empty one', async () => {
    // An empty `skill` would otherwise land as a stray '' member of the CSV.
    expect((await row('a2')).skill_names).toBe('claudescope:history');
  });

  it('stays empty for a non-Skill tool call', async () => {
    expect((await row('a1')).skill_names).toBe('');
  });
});
