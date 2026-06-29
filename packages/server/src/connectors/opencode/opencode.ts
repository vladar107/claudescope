/**
 * opencode connector.
 *
 * Unlike the other agents, opencode stores every transcript in ONE SQLite DB
 * (`~/.local/share/opencode/opencode.db`). The connector seam still fits: each
 * **session** is treated as a synthetic `DiscoveredFile` keyed `<dbPath>#<id>`,
 * `prepare()` extracts that session from the DB to a canonical NDJSON (the Codex
 * pattern), and `eventsProjectionSql` reads it 1:1. The DB is opened strictly
 * read-only via `node:sqlite` (Node 24 — no new dependency).
 *
 * opencode keeps no memory in its home dir, so this connector contributes none.
 *
 * STRICTLY READ-ONLY with respect to the opencode DB — it is only ever read.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDESCOPE_HOME, OPENCODE_DATA_DIR, OPENCODE_DB_PATH } from '../../config.js';
import { sqlString } from '../../db/duckdb.js';
import type { SessionData } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { listSessions, readSession } from './db.js';
import { buildEvents, toCanonicalRows } from './normalize.js';

const CACHE_DIR = join(CLAUDESCOPE_HOME, 'cache', 'opencode');

/** Synthetic per-session key → its DB path + session id. opencode ids are
 *  `ses_<base62>` (no `#`), so splitting on the first `#` is unambiguous. */
function makeKey(sessionId: string): string {
  return `${OPENCODE_DB_PATH}#${sessionId}`;
}
function parseKey(filePath: string): { dbPath: string; sessionId: string } {
  const i = filePath.indexOf('#');
  return i === -1
    ? { dbPath: filePath, sessionId: '' }
    : { dbPath: filePath.slice(0, i), sessionId: filePath.slice(i + 1) };
}

/** Deterministic temp NDJSON path for a given synthetic session key. */
function cachePath(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${hash}.ndjson`);
}

/**
 * One synthetic `DiscoveredFile` per session, with the change signal from
 * {@link listSessions}. Returns `[]` when the DB is absent; **throws** when the
 * DB exists but can't be read, so the indexer never mistakes a transient SQLite
 * failure for "all opencode sessions deleted" (the indexer isolates a throwing
 * connector and preserves its prior files — see `data/index.ts`).
 */
function discover(): DiscoveredFile[] {
  return listSessions(OPENCODE_DB_PATH).map((s) => ({
    path: makeKey(s.id),
    mtimeMs: s.mtimeMs,
    size: s.size,
  }));
}

/** Extract one session from the DB to a canonical NDJSON the projection reads. */
async function prepare(filePath: string): Promise<void> {
  const { dbPath, sessionId } = parseKey(filePath);
  const session = readSession(dbPath, sessionId);
  mkdirSync(CACHE_DIR, { recursive: true });
  const rows = session ? toCanonicalRows(session, filePath) : [];
  writeFileSync(cachePath(filePath), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function eventsProjectionSql(filePath: string): string {
  const path = sqlString(cachePath(filePath));
  return `
    SELECT
      file_path, session_id, uuid, parent_uuid, role, type, ts, cwd, git_branch,
      model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      service_tier, is_sidechain, tool_use_count, tool_names, text_content,
      CAST(NULL AS VARCHAR) AS message_id, CAST(NULL AS VARCHAR) AS forked_from_session_id
    FROM read_ndjson(${path}, format='newline_delimited', maximum_object_size=268435456, ignore_errors=true, columns={
      file_path:'VARCHAR', session_id:'VARCHAR', uuid:'VARCHAR', parent_uuid:'VARCHAR',
      role:'VARCHAR', type:'VARCHAR', ts:'TIMESTAMP', cwd:'VARCHAR', git_branch:'VARCHAR',
      model:'VARCHAR', input_tokens:'BIGINT', output_tokens:'BIGINT', cache_read_tokens:'BIGINT',
      cache_write_tokens:'BIGINT', service_tier:'VARCHAR', is_sidechain:'BOOLEAN',
      tool_use_count:'INTEGER', tool_names:'VARCHAR', text_content:'VARCHAR'
    })`;
}

/** opencode stores a real per-session title; carried through the cache NDJSON. */
function auxProjections(filePath: string): AuxProjections {
  if (!existsSync(cachePath(filePath))) return {};
  const path = sqlString(cachePath(filePath));
  return {
    titles: `
      SELECT session_id, last(title) AS title
      FROM read_ndjson(${path}, format='newline_delimited', maximum_object_size=268435456, ignore_errors=true,
        columns={session_id:'VARCHAR', title:'VARCHAR'})
      WHERE session_id IS NOT NULL AND title IS NOT NULL AND title <> ''
      GROUP BY session_id`,
  };
}

async function loadSession(_sessionId: string, paths: string[]): Promise<SessionData> {
  const mainEvents = paths.flatMap((p) => {
    const { dbPath, sessionId } = parseKey(p);
    const session = readSession(dbPath, sessionId);
    return session ? buildEvents(session) : [];
  });
  return { mainEvents, subagents: [] };
}

export const opencodeConnector: AgentConnector = {
  id: 'opencode',
  label: 'opencode',
  sourceDir: OPENCODE_DATA_DIR,
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  resumeSpec: (id) => ({
    resumeArgv: ['opencode', '--session', id],
    forkArgv: ['opencode', '--session', id, '--fork'],
  }),
};
