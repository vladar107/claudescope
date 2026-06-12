/**
 * OpenAI Codex CLI connector.
 *
 * Source layout: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Codex spreads a
 * session across record types, so it can't be projected per-row by DuckDB.
 * Instead `prepare()` normalizes a rollout to a canonical NDJSON (in TS, via
 * {@link parseRollout}/{@link toCanonicalRows}) and `eventsProjectionSql` reads
 * that 1:1 — the indexer/FTS/cost stay native and Claude's path is untouched.
 *
 * STRICTLY READ-ONLY with respect to ~/.codex — files are only ever read.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDESCOPE_HOME, CODEX_SESSIONS_DIR } from '../../config.js';
import { sqlString } from '../../db/duckdb.js';
import type { SessionData } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { parseRollout, toCanonicalRows } from './normalize.js';

const CACHE_DIR = join(CLAUDESCOPE_HOME, 'cache', 'codex');

/** Deterministic temp NDJSON path for a given rollout file. */
function cachePath(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${hash}.ndjson`);
}

/** Recursively collect every `rollout-*.jsonl` under the Codex sessions dir. */
function discover(): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try {
          const st = statSync(full);
          out.push({ path: full, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
        } catch {
          /* file vanished between readdir and stat; ignore */
        }
      }
    }
  };
  walk(CODEX_SESSIONS_DIR);
  return out;
}

/** Normalize a rollout to canonical NDJSON the projection will read. */
async function prepare(filePath: string): Promise<void> {
  const session = parseRollout(filePath);
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
      service_tier, is_sidechain, tool_use_count, text_content,
      CAST(NULL AS VARCHAR) AS message_id, CAST(NULL AS VARCHAR) AS forked_from_session_id
    FROM read_ndjson(${path}, format='newline_delimited', maximum_object_size=268435456, ignore_errors=true, columns={
      file_path:'VARCHAR', session_id:'VARCHAR', uuid:'VARCHAR', parent_uuid:'VARCHAR',
      role:'VARCHAR', type:'VARCHAR', ts:'TIMESTAMP', cwd:'VARCHAR', git_branch:'VARCHAR',
      model:'VARCHAR', input_tokens:'BIGINT', output_tokens:'BIGINT', cache_read_tokens:'BIGINT',
      cache_write_tokens:'BIGINT', service_tier:'VARCHAR', is_sidechain:'BOOLEAN',
      tool_use_count:'INTEGER', text_content:'VARCHAR'
    })`;
}

function auxProjections(_filePath: string): AuxProjections {
  return {}; // Codex has no ai-title / pr-link records
}

async function loadSession(_sessionId: string, paths: string[]): Promise<SessionData> {
  const mainEvents = paths.flatMap((p) => parseRollout(p)?.events ?? []);
  return { mainEvents, subagents: [] };
}

export const codexConnector: AgentConnector = {
  id: 'codex',
  label: 'Codex',
  sourceDir: CODEX_SESSIONS_DIR,
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
};
