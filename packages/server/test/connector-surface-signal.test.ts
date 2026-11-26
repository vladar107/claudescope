/**
 * Fitness function for the surface ("started from") signal contract.
 *
 * `sessions.surface` is only meaningful for an agent whose format records the
 * client a session ran from; for every other agent the API must report it
 * ABSENT, never a guessed `cli`. It is derived from `events.entrypoint`, so two
 * ways to break that are invisible in a connector's own test: a connector left
 * out of the declaration (the API's absent/present decision has nothing to go
 * on), and an undeclared connector whose projection quietly fills the column
 * (a surface indexed for an agent that cannot report one).
 *
 * So this test walks the real registry: every connector id must be declared
 * either with or without the signal, and every undeclared connector's events
 * projection must emit a NULL `entrypoint` — even over a normalize cache whose
 * row carries an `entrypoint` field. Claude Code's non-NULL path is covered end
 * to end by `surface.integration.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { CanonicalRow } from '../src/connectors/canonical.js';
import type { AgentConnector } from '../src/connectors/types.js';

// The registry import resolves each connector's source dir; keep any state it
// might touch inside a temp home, never the real one.
const work = mkdtempSync(join(tmpdir(), 'claudescope-surfacesignal-'));
process.env.CLAUDESCOPE_HOME = join(work, 'home');
process.env.DUCKDB_PATH = join(work, 'index.duckdb');

let registry: AgentConnector[];
let withSignal: string[];
let withoutSignal: string[];
let hasSurfaceSignal: (id: string) => boolean;
let conn: DuckDBConnection;
let queryRows: typeof import('../src/db/duckdb.js').queryRows;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  const capabilities = await import('../src/data/agent-capabilities.js');
  ({ connectors: registry } = await import('../src/connectors/registry.js'));
  withSignal = capabilities.connectorsWithSurfaceSignal();
  withoutSignal = capabilities.connectorsWithoutSurfaceSignal();
  hasSurfaceSignal = capabilities.hasSurfaceSignal;
  const duck = await import('../src/db/duckdb.js');
  ({ queryRows, closeConnection } = duck);
  conn = await duck.getConnection();
});

afterAll(async () => {
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('surface signal declaration', () => {
  it('classifies every registered connector exactly once', () => {
    const ids = registry.map((c) => c.id);
    expect([...withSignal, ...withoutSignal].sort()).toEqual([...ids].sort());
    expect(withSignal.filter((id) => withoutSignal.includes(id))).toEqual([]);
    for (const id of withSignal) expect(hasSurfaceSignal(id)).toBe(true);
    for (const id of withoutSignal) expect(hasSurfaceSignal(id)).toBe(false);
  });

  it('declares a surface for Claude Code (its `entrypoint` field)', () => {
    expect(hasSurfaceSignal('claude-code')).toBe(true);
  });

  it('projects a NULL entrypoint for every undeclared connector', async () => {
    const { ndjsonCache } = await import('../src/connectors/ndjson-cache.js');
    const path = join(work, 'probe.jsonl');
    const row: CanonicalRow & { entrypoint: string } = {
      file_path: path, session_id: 'probe', uuid: 'u1', parent_uuid: null, role: 'user', type: 'user',
      ts: '2026-06-01T10:00:00.000Z', cwd: '/tmp/probe', git_branch: null, model: null,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0,
      service_tier: null, speed: null, is_sidechain: false, tool_use_count: 0, tool_names: '',
      tool_error_count: null, tool_error_text: null, skill_names: '', subagent_names: '', text_content: 'hi',
      // A field a normalizer might leak into its cache; the projection must not read it.
      entrypoint: 'cli',
    };
    const undeclared = registry.filter((c) => !hasSurfaceSignal(c.id));
    expect(undeclared.length).toBeGreaterThan(0);
    for (const connector of undeclared) {
      // Relies on each cache-backed connector naming its cache with its own id.
      ndjsonCache(connector.id).write(path, [row]);
      const rows = await queryRows(conn, `SELECT entrypoint FROM (${connector.eventsProjectionSql(path)})`);
      expect(rows.length, `${connector.id} projected no row from its cache`).toBe(1);
      expect(rows[0]!.entrypoint, `${connector.id} projects a surface it does not declare`).toBeNull();
    }
  });
});
