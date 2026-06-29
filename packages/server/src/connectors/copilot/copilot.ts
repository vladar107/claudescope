/**
 * GitHub Copilot CLI connector.
 *
 * Source layout: `~/.copilot/session-state/<uuid>/events.jsonl` (one event-sourced
 * stream per session) plus a sibling `workspace.yaml` (title/cwd/branch) and an
 * optional `files/` attachment dir. Like Codex/Junie/pi, the stream can't be
 * projected per-row by DuckDB, so `prepare()` normalizes a session to canonical
 * NDJSON (in TS, via {@link parseCopilotSession}/{@link toCanonicalRows}) and
 * `eventsProjectionSql` reads that 1:1 — the indexer/FTS/cost stay native.
 *
 * Global memory is the user-authored `~/.copilot/copilot-instructions.md`
 * ({@link copilotGlobalMemory}); there is no cross-session per-project store.
 *
 * STRICTLY READ-ONLY with respect to ~/.copilot — files are only ever read.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDESCOPE_HOME, COPILOT_SESSIONS_DIR } from '../../config.js';
import { sqlString } from '../../db/duckdb.js';
import type { SessionData } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { parseCopilotSession, toCanonicalRows } from './normalize.js';
import { copilotGlobalMemory } from './memory.js';

const CACHE_DIR = join(CLAUDESCOPE_HOME, 'cache', 'copilot');

/** Deterministic temp NDJSON path for a given session file. */
function cachePath(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${hash}.ndjson`);
}

/** Collect every `<uuid>/events.jsonl` under the Copilot session-state dir. */
function discover(): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  let dirs: import('node:fs').Dirent[];
  try {
    dirs = readdirSync(COPILOT_SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return out; // no Copilot install
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const full = join(COPILOT_SESSIONS_DIR, dir.name, 'events.jsonl');
    try {
      const st = statSync(full);
      out.push({ path: full, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
    } catch {
      /* a session-state dir without an events.jsonl yet; ignore */
    }
  }
  return out;
}

/** Normalize a session to canonical NDJSON the projection will read. */
async function prepare(filePath: string): Promise<void> {
  const session = parseCopilotSession(filePath);
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

/** Copilot carries a real session title (workspace.yaml `name`), threaded through
 *  the cache NDJSON; the first-user-message fallback applies when it's empty. */
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
  // resolveImages: pull saved-attachment bytes off disk for the detail view.
  const mainEvents = paths.flatMap((p) => parseCopilotSession(p, { resolveImages: true })?.events ?? []);
  return { mainEvents, subagents: [] };
}

export const copilotConnector: AgentConnector = {
  id: 'copilot',
  label: 'GitHub Copilot CLI',
  sourceDir: COPILOT_SESSIONS_DIR,
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  globalMemory: copilotGlobalMemory,
  // Copilot CLI has no command-line fork (only an in-session `/fork`), so resume only.
  resumeSpec: (id) => ({ resumeArgv: ['copilot', '--resume', id] }),
};
