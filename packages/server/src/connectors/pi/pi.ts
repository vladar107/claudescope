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
 * Subagent runs (`<sessionBase>/<runId>/run-<N>/session.jsonl`) are re-keyed to
 * the parent session at index time and embedded as SubagentSources at their
 * spawning `subagent` toolCall (→ canonical `Task`) in {@link loadSession}.
 *
 * pi keeps no instruction/memory files in its home dir (only `settings.json` /
 * `auth.json`), so this connector contributes no memory.
 *
 * STRICTLY READ-ONLY with respect to ~/.pi — files are only ever read.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { CLAUDESCOPE_HOME, PI_SESSIONS_DIR } from '../../config.js';
import { sqlString } from '../../db/duckdb.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { parentSessionFile, parsePiSession, subagentRuns, toCanonicalRows } from './normalize.js';

const CACHE_DIR = join(CLAUDESCOPE_HOME, 'cache', 'pi');

/** Deterministic temp NDJSON path for a given session file. */
function cachePath(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${hash}.ndjson`);
}

/**
 * Recursively collect every `*.jsonl` under the pi sessions dir — including
 * nested subagent transcripts (`<sessionBase>/<runId>/run-<N>/session.jsonl`),
 * which normalize re-keys to their parent session. No parent-mtime folding is
 * needed (unlike antigravity): a child's parentage is derived from the path
 * shape and the parent's immutable session id, both fixed from the moment the
 * child exists, so its re-key never changes retroactively.
 */
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

function auxProjections(_filePath: string): AuxProjections {
  return {}; // pi has no ai-title / pr-link records (first-user-message title fallback applies)
}

async function loadSession(_sessionId: string, paths: string[]): Promise<SessionData> {
  // `paths` holds the top-level file(s) plus any nested subagent transcripts the
  // index re-keyed to this session. Only top-level files feed the main thread;
  // children are attached below at their spawning `Task` call. A child whose
  // parent file has vanished no longer matches the nested shape and is promoted
  // to a main file (mirrors antigravity's orphan fallback). If NO path is
  // top-level (e.g. the parent indexed zero events, so only children map here),
  // promote everything rather than serve an empty session.
  let mainPaths = paths.filter((p) => parentSessionFile(p) === null);
  if (mainPaths.length === 0) mainPaths = paths;
  const mainSet = new Set(mainPaths);
  const mainEvents = mainPaths.flatMap((p) => parsePiSession(p)?.events ?? []);

  const subagents: SubagentSource[] = [];
  const attached = new Set<string>();
  for (const p of mainPaths) {
    const childRoot = join(dirname(p), basename(p, '.jsonl'));
    for (const run of subagentRuns(p)) {
      const childPath = join(childRoot, run.runId, `run-${run.runIndex}`, 'session.jsonl');
      const child = parsePiSession(childPath);
      if (!child) continue; // run dir pruned since the session ran — tolerate
      attached.add(childPath);
      subagents.push({
        agentId: child.ownId,
        agentType: run.agentType,
        description: run.description,
        events: child.events,
      });
    }
  }

  // Children indexed under this session but never claimed by a subagent
  // toolResult (crashed mid-run, an extra run-N beyond `results`, an unreadable
  // parent): attach them detached — empty description ⇒ the thread assembler
  // renders them unanchored — so their indexed text stays reachable in detail.
  for (const p of paths) {
    if (mainSet.has(p) || attached.has(p)) continue;
    const child = parsePiSession(p);
    if (!child) continue;
    subagents.push({ agentId: child.ownId, agentType: '', description: '', events: child.events });
  }
  return { mainEvents, subagents };
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
