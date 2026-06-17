/**
 * pi (`@earendil-works/pi-coding-agent`) connector.
 *
 * Source layout: `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`. pi
 * spreads session-level facts (cwd on the `session` line, tool results in their
 * own `toolResult` records), so it can't be projected per-row by DuckDB. Instead
 * `prepare()` normalizes a session to a canonical NDJSON (in TS, via
 * {@link parsePiSession}/{@link toCanonicalRows}) and `eventsProjectionSql` reads
 * that 1:1 — the indexer/FTS/cost stay native and Claude's path is untouched.
 *
 * pi keeps no instruction/memory files in its home dir (only `settings.json` /
 * `auth.json`), so this connector contributes no memory.
 *
 * STRICTLY READ-ONLY with respect to ~/.pi — files are only ever read.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDESCOPE_HOME, PI_SESSIONS_DIR } from '../../config.js';
import { sqlString } from '../../db/duckdb.js';
import type { SessionData } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { parsePiSession, toCanonicalRows } from './normalize.js';

const CACHE_DIR = join(CLAUDESCOPE_HOME, 'cache', 'pi');

/** Deterministic temp NDJSON path for a given session file. */
function cachePath(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${hash}.ndjson`);
}

/** Recursively collect every `*.jsonl` under the pi sessions dir. */
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
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = statSync(full);
          out.push({ path: full, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
        } catch {
          /* file vanished between readdir and stat; ignore */
        }
      }
    }
  };
  walk(PI_SESSIONS_DIR);
  return out;
}

/** Normalize a session to canonical NDJSON the projection will read. */
async function prepare(filePath: string): Promise<void> {
  const session = parsePiSession(filePath);
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
  return {}; // pi has no ai-title / pr-link records (first-user-message title fallback applies)
}

async function loadSession(_sessionId: string, paths: string[]): Promise<SessionData> {
  const mainEvents = paths.flatMap((p) => parsePiSession(p)?.events ?? []);
  return { mainEvents, subagents: [] };
}

export const piConnector: AgentConnector = {
  id: 'pi',
  label: 'pi',
  sourceDir: PI_SESSIONS_DIR,
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  resumeSpec: (id) => ({
    resumeArgv: ['pi', '--session', id],
    forkArgv: ['pi', '--fork', id],
  }),
};
