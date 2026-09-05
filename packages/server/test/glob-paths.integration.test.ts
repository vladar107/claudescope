/**
 * DuckDB's `read_ndjson` treats its path argument as a GLOB, not a literal
 * path: `*`, `?`, and `[` are metacharacters (verified: `read_ndjson('/x/x[1].jsonl')`
 * silently returns the contents of the sibling `/x/x1.jsonl`). A Claude Code
 * project directory is named by encoding the session's cwd, so a cwd
 * containing one of those characters (e.g. `/Users/me/proj[1]`) produces a
 * project directory whose name is itself a stray glob pattern.
 *
 * Fixture: two project directories differing only by a bracket, each holding a
 * file with the SAME basename (`sess.jsonl`) but a distinct session/text. That
 * basename collision is what makes the bug bite: unescaped, DuckDB's glob
 * resolves `-Users-me-proj-[1]/sess.jsonl` to the sibling
 * `-Users-me-proj-1/sess.jsonl` instead of its own file, so the bracketed
 * project's session silently disappears and its sibling's session absorbs both
 * files' events. `sqlPath` (db/duckdb.ts) escapes the glob metacharacters in
 * the read path while the `file_path` column keeps the raw path (see
 * connectors/claude-code/claude-code.ts).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-globpaths-'));
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
process.env.PRICING_REFRESH_INTERVAL_MS = '0';

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Two projects encoded with/without a bracket, each with a same-named file. */
function writeFixtures(): void {
  const bracketDir = join(projectsDir, '-Users-me-proj-[1]');
  const plainDir = join(projectsDir, '-Users-me-proj-1');
  mkdirSync(bracketDir, { recursive: true });
  mkdirSync(plainDir, { recursive: true });

  const baseA = { sessionId: 'sessA', cwd: '/tmp/proj1a', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(bracketDir, 'sess.jsonl'),
    jsonl([
      { type: 'ai-title', sessionId: 'sessA', aiTitle: 'Session A' },
      { ...baseA, type: 'user', uuid: 'a-u1', parentUuid: null, timestamp: '2026-05-01T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'needle-A unique text' } },
      { ...baseA, type: 'assistant', uuid: 'a-a1', parentUuid: 'a-u1', timestamp: '2026-05-01T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'reply-A unique text' }], usage: { input_tokens: 10, output_tokens: 5 } } },
    ]),
  );

  const baseB = { sessionId: 'sessB', cwd: '/tmp/proj1b', gitBranch: 'main', version: '2.1.0' };
  writeFileSync(
    join(plainDir, 'sess.jsonl'),
    jsonl([
      { type: 'ai-title', sessionId: 'sessB', aiTitle: 'Session B' },
      { ...baseB, type: 'user', uuid: 'b-u1', parentUuid: null, timestamp: '2026-05-02T10:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'needle-B unique text' } },
      { ...baseB, type: 'assistant', uuid: 'b-a1', parentUuid: 'b-u1', timestamp: '2026-05-02T10:00:05.000Z', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'reply-B unique text' }], usage: { input_tokens: 12, output_tokens: 6 } } },
    ]),
  );
}

let getConnection: typeof import('../src/db/duckdb.js').getConnection;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let closeConnection: typeof import('../src/db/duckdb.js').closeConnection;

afterAll(async () => {
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('a bracketed project directory name', () => {
  it('does not leak into a sibling directory that matches it as a glob', async () => {
    writeFixtures();

    const duck = await import('../src/db/duckdb.js');
    ({ getConnection, queryRows, closeConnection } = duck);
    const { reindex } = await import('../src/data/index.js');
    await reindex();

    const conn = await getConnection();
    const counts = await queryRows(
      conn,
      "SELECT session_id, count(*) AS n FROM events GROUP BY session_id ORDER BY session_id",
    );
    expect(counts).toEqual([
      { session_id: 'sessA', n: 2 },
      { session_id: 'sessB', n: 2 },
    ]);

    const textA = await queryRows(
      conn,
      "SELECT text_content FROM events WHERE session_id = 'sessA' AND role = 'user'",
    );
    expect(textA[0]?.text_content).toBe('needle-A unique text');

    const textB = await queryRows(
      conn,
      "SELECT text_content FROM events WHERE session_id = 'sessB' AND role = 'user'",
    );
    expect(textB[0]?.text_content).toBe('needle-B unique text');
  });
});
