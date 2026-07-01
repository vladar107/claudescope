import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const work = mkdtempSync(join(tmpdir(), 'claudescope-tn-'));
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
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.REINDEX_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

let getConnection: typeof import('../src/db/duckdb.js').getConnection;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let closeConnection: typeof import('../src/db/duckdb.js').closeConnection;

beforeAll(async () => {
  // Claude Code: one assistant message with two tool_use blocks (Edit, Bash).
  const projA = join(projectsDir, 'enc-projA');
  mkdirSync(projA, { recursive: true });
  const base = { sessionId: 'sessA', cwd: '/tmp/projA', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(projA, 'sessA.jsonl'),
    jsonl([
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'go' } },
      { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-01-01T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: {} }, { type: 'tool_use', id: 't2', name: 'Bash', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } } },
    ]),
  );

  // Codex: a function_call that canonicalizes to Bash (shell), to prove cross-connector flow.
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, 'rollout-2026-01-01T10-00-00-019db3da-f840-7142-a548-5bd30f5fe572.jsonl'),
    jsonl([
      { type: 'session_meta', timestamp: '2026-01-01T10:00:00.000Z', payload: { id: 'codex-sess-1', cwd: '/tmp/codexproj', cli_version: '0.122.0', model_provider: 'openai', git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: '2026-01-01T10:00:01.000Z', payload: { model: 'gpt-5.4', cwd: '/tmp/codexproj' } },
      { type: 'response_item', timestamp: '2026-01-01T10:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] } },
      { type: 'response_item', timestamp: '2026-01-01T10:00:03.000Z', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' } },
      { type: 'response_item', timestamp: '2026-01-01T10:00:04.000Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'x' } },
      { type: 'event_msg', timestamp: '2026-01-01T10:00:05.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 } }, rate_limits: {} } },
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

describe('tool_names indexing', () => {
  it('captures multiple canonical tool names per Claude Code event', async () => {
    const conn = await getConnection();
    const rows = await queryRows(conn, "SELECT tool_names FROM events WHERE uuid = 'a1'");
    expect(rows[0]?.tool_names).toBe('Edit,Bash');
  });

  it('captures canonicalized tool names from the Codex connector', async () => {
    const conn = await getConnection();
    // Codex `shell` function_call canonicalizes to Bash.
    const rows = await queryRows(
      conn,
      "SELECT tool_names FROM events WHERE type='assistant' AND tool_names <> '' AND session_id LIKE 'codex-%'",
    );
    expect(rows.map((r) => r.tool_names)).toContain('Bash');
  });

  it('leaves tool_names empty for non-tool events', async () => {
    const conn = await getConnection();
    const rows = await queryRows(conn, "SELECT tool_names FROM events WHERE uuid = 'u1'");
    expect(rows[0]?.tool_names).toBe('');
  });
});
