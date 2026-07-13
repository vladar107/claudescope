/**
 * Google Antigravity connector.
 *
 * Source layout: `<appDataDir>/brain/<conv-id>/.system_generated/logs/transcript_full.jsonl`
 * across two appDataDirs that share the format — the CLI (`~/.gemini/antigravity-cli/`)
 * and the desktop app (`~/.gemini/antigravity/`). Like Codex/Junie/pi/Copilot the
 * event stream can't be projected per-row by DuckDB, so `prepare()` normalizes a
 * session to canonical NDJSON ({@link parseAntigravitySession}/{@link toCanonicalRows})
 * and `eventsProjectionSql` reads that 1:1 — the indexer/FTS/cost stay native.
 *
 * Subagents are separate conversations re-parented under their root session
 * ({@link parseAntigravitySession}), so `loadSession` splits the resolved files
 * into the main transcript and one {@link SubagentSource} per subagent, which the
 * thread assembler nests at the parent's `invoke_subagent` (→ `Task`) call.
 *
 * There are no token counts, so cost is unavailable by design (every row is zero,
 * counted once). Global memory is `~/.gemini/config/agents/AGENTS.md` / `GEMINI.md`.
 *
 * STRICTLY READ-ONLY with respect to ~/.gemini — files are only ever read.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemorySource, RawEvent } from '@claudescope/shared';
import { ANTIGRAVITY_DIRS, ANTIGRAVITY_SOURCE_DIR, CLAUDESCOPE_HOME } from '../../config.js';
import { sqlString } from '../../db/duckdb.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import {
  getContext,
  listTranscripts,
  parseAntigravitySession,
  rootConvId,
  subagentMetaFor,
  toCanonicalRows,
} from './normalize.js';
import { antigravityGlobalMemory } from './memory.js';

const CACHE_DIR = join(CLAUDESCOPE_HOME, 'cache', 'antigravity');

/** Deterministic temp NDJSON path for a given source file. */
function cachePath(filePath: string): string {
  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${hash}.ndjson`);
}

/** Every transcript across both Antigravity appDataDirs. */
function discover(): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const dir of ANTIGRAVITY_DIRS) {
    const transcripts = listTranscripts(dir);
    if (transcripts.length === 0) continue;
    const { subagents } = getContext(dir);
    const mtimeByConv = new Map(transcripts.map((t) => [t.convId, t.mtimeMs]));
    for (const t of transcripts) {
      // A subagent is re-parented under its root conversation at prepare time
      // using the cross-file linkage map. Fold the root transcript's mtime into
      // the child's change-detection key, so when the parent gains (or loses) the
      // link, the indexer re-processes the child instead of leaving a stale
      // session_id behind (the child's own bytes never change once it finishes).
      let mtimeMs = t.mtimeMs;
      if (subagents.has(t.convId)) {
        const rootMtime = mtimeByConv.get(rootConvId(t.convId, subagents));
        if (rootMtime !== undefined) mtimeMs = Math.max(mtimeMs, rootMtime);
      }
      out.push({ path: t.path, mtimeMs, size: t.size });
    }
  }
  return out;
}

/** Normalize a session to canonical NDJSON the projection will read. */
async function prepare(filePath: string): Promise<void> {
  const rows = toCanonicalRows(parseAntigravitySession(filePath), filePath);
  mkdirSync(CACHE_DIR, { recursive: true });
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

/** Antigravity stores no title → rely on the first-user-message fallback. */
function auxProjections(_filePath: string): AuxProjections {
  return {};
}

/**
 * Load a session's events, splitting the resolved files into the main transcript
 * (its conv-id equals the session id) and one subagent per re-parented child
 * transcript. Images are resolved here (detail view only).
 */
async function loadSession(sessionId: string, paths: string[]): Promise<SessionData> {
  const present = paths.filter((p) => existsSync(p));
  const mainEvents: RawEvent[] = [];
  const subagents: SubagentSource[] = [];
  for (const p of present) {
    const parsed = parseAntigravitySession(p, { resolveImages: true });
    if (parsed.convId === sessionId) {
      mainEvents.push(...parsed.events);
    } else {
      const meta = subagentMetaFor(p);
      subagents.push({
        agentId: parsed.convId,
        agentType: meta?.agentType ?? '',
        description: meta?.description ?? '',
        events: parsed.events,
      });
    }
  }
  // Fallback: a session whose main transcript is missing (e.g. the parent file was
  // deleted while a re-parented subagent still resolves under its id) would render
  // an empty main thread. Promote the subagents to the main thread so it shows.
  if (mainEvents.length === 0 && subagents.length > 0) {
    return { mainEvents: subagents.flatMap((s) => s.events), subagents: [] };
  }
  return { mainEvents, subagents };
}

function globalMemory(): MemorySource[] {
  return antigravityGlobalMemory();
}

export const antigravityConnector: AgentConnector = {
  id: 'antigravity',
  label: 'Antigravity',
  sourceDir: ANTIGRAVITY_SOURCE_DIR,
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  globalMemory,
  // `agy --conversation <id>` resumes a previous conversation by id (no CLI fork).
  resumeSpec: (id) => ({ resumeArgv: ['agy', '--conversation', id] }),
};
