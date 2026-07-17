/**
 * xAI Grok CLI connector.
 *
 * Source layout: `~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/` — a
 * directory per session holding `chat_history.jsonl` (the message spine),
 * `updates.jsonl` (timestamps + per-turn usage), and `summary.json` (cwd,
 * title). The facts are spread across the three files, so `prepare()`
 * normalizes a session to canonical NDJSON (in TS, via
 * {@link parseGrokSession}/{@link toCanonicalRows}) and `eventsProjectionSql`
 * reads that 1:1 — the indexer/FTS/cost stay native.
 *
 * Subagent children are SIBLING session dirs re-keyed to the parent at index
 * time (linkage: the parent's `subagents/<child-id>/meta.json`) and embedded
 * as SubagentSources at their spawning `spawn_subagent` call (→ canonical
 * `Task`) in {@link loadSession}.
 *
 * Grok's cross-session memory (`~/.grok/memory/`) is experimental and off by
 * default, so this connector contributes no memory (v1).
 *
 * STRICTLY READ-ONLY with respect to ~/.grok — files are only ever read.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAUDESCOPE_HOME, GROK_SESSIONS_DIR } from '../../config.js';
import { sqlString } from '../../db/duckdb.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { parentSessionDirOf, parseGrokSession, subagentMetas, toCanonicalRows } from './normalize.js';

const CACHE_DIR = join(CLAUDESCOPE_HOME, 'cache', 'grok');

/** Deterministic temp NDJSON path for a given session file. */
function cachePath(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${hash}.ndjson`);
}

/**
 * Fold a session's three files into one change signal. The discovery unit is
 * `chat_history.jsonl`, but usage arrives in `updates.jsonl` and the title in
 * `summary.json` — both often written AFTER the last chat row — so mtime/size
 * must cover all three or those late writes never trigger a re-index.
 */
function foldedStat(chatPath: string): Pick<DiscoveredFile, 'mtimeMs' | 'size'> | null {
  const sessionDir = dirname(chatPath);
  let mtimeMs = 0;
  let size = 0;
  try {
    const st = statSync(chatPath);
    mtimeMs = Math.floor(st.mtimeMs);
    size = st.size;
  } catch {
    return null; // no chat_history — not a session (or it vanished)
  }
  for (const sibling of ['updates.jsonl', 'summary.json']) {
    try {
      const st = statSync(join(sessionDir, sibling));
      mtimeMs = Math.max(mtimeMs, Math.floor(st.mtimeMs));
      size += st.size;
    } catch {
      /* sibling missing — chat_history alone still indexes */
    }
  }
  return { mtimeMs, size };
}

/**
 * Collect every `<cwd-dir>/<session-uuid>/chat_history.jsonl` under the Grok
 * sessions dir — including subagent children (re-keyed by normalize). The
 * exact path shape skips `session_search.sqlite`, the per-cwd
 * `prompt_history.jsonl`, and the session dir's other files by construction.
 */
function discover(): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  let cwdDirs: import('node:fs').Dirent[];
  try {
    cwdDirs = readdirSync(GROK_SESSIONS_DIR, { withFileTypes: true });
  } catch {
    return out; // no Grok install
  }
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    let sessionDirs: import('node:fs').Dirent[];
    try {
      sessionDirs = readdirSync(join(GROK_SESSIONS_DIR, cwdDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const chatPath = join(GROK_SESSIONS_DIR, cwdDir.name, sessionDir.name, 'chat_history.jsonl');
      const st = foldedStat(chatPath);
      if (st) out.push({ path: chatPath, ...st });
    }
  }
  return out;
}

/** Normalize a session to canonical NDJSON the projection will read. */
async function prepare(filePath: string): Promise<void> {
  const session = parseGrokSession(filePath);
  mkdirSync(CACHE_DIR, { recursive: true });
  const rows = session ? toCanonicalRows(session, filePath) : [];
  writeFileSync(cachePath(filePath), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function eventsProjectionSql(filePath: string): string {
  const path = sqlString(cachePath(filePath));
  return `
    SELECT
      file_path, session_id, uuid, parent_uuid, role, type, ts, cwd, git_branch,
      model, CAST(NULL AS VARCHAR) AS provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      service_tier, is_sidechain, tool_use_count, tool_names, tool_error_count, text_content,
      CAST(NULL AS VARCHAR) AS message_id, CAST(NULL AS VARCHAR) AS forked_from_session_id
    FROM read_ndjson(${path}, format='newline_delimited', maximum_object_size=268435456, ignore_errors=true, columns={
      file_path:'VARCHAR', session_id:'VARCHAR', uuid:'VARCHAR', parent_uuid:'VARCHAR',
      role:'VARCHAR', type:'VARCHAR', ts:'TIMESTAMP', cwd:'VARCHAR', git_branch:'VARCHAR',
      model:'VARCHAR', input_tokens:'BIGINT', output_tokens:'BIGINT', cache_read_tokens:'BIGINT',
      cache_write_tokens:'BIGINT', service_tier:'VARCHAR', is_sidechain:'BOOLEAN',
      tool_use_count:'INTEGER', tool_names:'VARCHAR', tool_error_count:'INTEGER', text_content:'VARCHAR'
    })`;
}

/** Grok carries a real session title (summary.json `generated_title`), threaded
 *  through the cache NDJSON; the first-user-message fallback applies when empty. */
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
  // `paths` holds the top-level file(s) plus any subagent children the index
  // re-keyed to this session. Only top-level files feed the main thread;
  // children attach below at their spawning `Task` call. If NO path is
  // top-level (parent dir vanished, so only children map here), promote
  // everything rather than serve an empty session.
  let mainPaths = paths.filter((p) => parentSessionDirOf(p) === null);
  if (mainPaths.length === 0) mainPaths = paths;
  const mainSet = new Set(mainPaths);
  const mainEvents = mainPaths.flatMap((p) => parseGrokSession(p)?.events ?? []);

  const subagents: SubagentSource[] = [];
  const attached = new Set<string>();
  for (const p of mainPaths) {
    const cwdDir = dirname(dirname(p));
    for (const meta of subagentMetas(dirname(p))) {
      const childPath = join(cwdDir, meta.childId, 'chat_history.jsonl');
      const child = parseGrokSession(childPath);
      if (!child) continue; // child dir pruned since the session ran — tolerate
      attached.add(childPath);
      subagents.push({
        agentId: child.ownId,
        agentType: meta.agentType,
        description: meta.description,
        events: child.events,
      });
    }
  }

  // Children indexed under this session but never claimed by a meta record
  // (unreadable meta.json): attach them detached — empty description ⇒ the
  // thread assembler renders them unanchored — so their text stays reachable.
  for (const p of paths) {
    if (mainSet.has(p) || attached.has(p)) continue;
    const child = parseGrokSession(p);
    if (!child) continue;
    subagents.push({ agentId: child.ownId, agentType: '', description: '', events: child.events });
  }
  return { mainEvents, subagents };
}

export const grokConnector: AgentConnector = {
  id: 'grok',
  label: 'Grok CLI',
  sourceDir: GROK_SESSIONS_DIR,
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  statFile: foldedStat,
  resumeSpec: (id) => ({
    resumeArgv: ['grok', '--resume', id],
    forkArgv: ['grok', '--resume', id, '--fork-session'],
  }),
};
