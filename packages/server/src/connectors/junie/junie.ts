/**
 * JetBrains Junie connector.
 *
 * Source layout: `~/.junie/sessions/index.jsonl` (one line per session) plus
 * `~/.junie/sessions/session-<id>/events.jsonl` (the transcript). Junie's
 * transcript is an event-sourced UI render stream, not a per-row conversation,
 * so — like the Codex connector — `prepare()` normalizes a session to a
 * canonical NDJSON (in TS, via {@link parseSession}/{@link toCanonicalRows}) and
 * `eventsProjectionSql` reads that 1:1. The indexer/FTS/cost stay shared.
 *
 * STRICTLY READ-ONLY with respect to ~/.junie — files are only ever read.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemorySource } from '@claudescope/shared';
import { CLAUDESCOPE_HOME, JUNIE_HOME, JUNIE_SESSIONS_DIR } from '../../config.js';
import { contractHome } from '../../util/paths.js';
import { sqlString } from '../../db/duckdb.js';
import type { SessionData } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { parseSession, toCanonicalRows } from './normalize.js';

const CACHE_DIR = join(CLAUDESCOPE_HOME, 'cache', 'junie');

/** Deterministic temp NDJSON path for a given events file. */
function cachePath(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${hash}.ndjson`);
}

/**
 * One `DiscoveredFile` per session listed in `index.jsonl`, pointing at that
 * session's `events.jsonl`. Reading from the index (rather than walking dirs)
 * mirrors how Junie itself enumerates sessions and skips stray subdirectories.
 */
function discover(): DiscoveredFile[] {
  const indexPath = join(JUNIE_SESSIONS_DIR, 'index.jsonl');
  let raw: string;
  try {
    raw = readFileSync(indexPath, 'utf8');
  } catch {
    return []; // Junie not installed / no sessions — nothing to index
  }
  const out: DiscoveredFile[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let sessionId: string;
    try {
      sessionId = String((JSON.parse(t) as { sessionId?: unknown }).sessionId ?? '');
    } catch {
      continue;
    }
    if (!sessionId) continue;
    const full = join(JUNIE_SESSIONS_DIR, sessionId, 'events.jsonl');
    try {
      const st = statSync(full);
      out.push({ path: full, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
    } catch {
      /* session dir without an events.jsonl yet; ignore */
    }
  }
  return out;
}

/** Normalize a session to canonical NDJSON the projection will read. */
async function prepare(filePath: string): Promise<void> {
  const session = parseSession(filePath);
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

/** Junie has an explicit session title (taskName); no PR links. */
function auxProjections(filePath: string): AuxProjections {
  const path = sqlString(cachePath(filePath));
  if (!existsSync(cachePath(filePath))) return {};
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
  const mainEvents = paths.flatMap((p) => parseSession(p)?.events ?? []);
  return { mainEvents, subagents: [] };
}

/**
 * Junie's global, user-authored instruction file: `~/.junie/AGENTS.md`. Junie's
 * per-project memory (`<repo>/.junie/memory/`) is repo-local and intentionally
 * OUT OF SCOPE — surfacing it would require reading arbitrary user project
 * directories, violating the home-dir-only invariant (see plan 0014); hence no
 * `projectMemory`. Returns `[]` when the file is absent.
 */
function globalMemory(): MemorySource[] {
  const agentsPath = join(JUNIE_HOME, 'AGENTS.md');
  try {
    const markdown = readFileSync(agentsPath, 'utf8');
    if (!markdown.trim()) return []; // empty file → no memory
    return [
      {
        provenance: 'user-authored',
        kind: 'document',
        title: 'AGENTS.md (global)',
        markdown,
        sourcePath: contractHome(agentsPath),
        updatedAt: new Date(statSync(agentsPath).mtimeMs).toISOString(),
      },
    ];
  } catch {
    return []; // no global instruction file — a normal, first-class empty state
  }
}

export const junieConnector: AgentConnector = {
  id: 'junie',
  label: 'Junie',
  sourceDir: JUNIE_SESSIONS_DIR,
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  globalMemory,
};
