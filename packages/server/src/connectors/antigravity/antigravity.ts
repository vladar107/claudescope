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

import { existsSync } from 'node:fs';
import type { MemorySource, RawEvent } from '@claudescope/shared';
import { antigravityDirs, antigravitySourceDir } from '../../settings.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { canonicalProjectionSql } from '../canonical.js';
import { ndjsonCache } from '../ndjson-cache.js';
import {
  getContext,
  listTranscripts,
  parseAntigravitySession,
  rootConvId,
  subagentMetaFor,
  toCanonicalRows,
} from './normalize.js';
import { antigravityGlobalMemory } from './memory.js';

const cache = ndjsonCache('antigravity');

/** Every transcript across both Antigravity appDataDirs. */
function discover(): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];
  for (const dir of antigravityDirs()) {
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
  cache.write(filePath, rows);
}

function eventsProjectionSql(filePath: string): string {
  return canonicalProjectionSql(cache.path(filePath), { provider: false });
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
      // A spawning conversation that is itself a subagent scopes the description
      // match to that run's own `invoke_subagent` calls; the root is implied.
      const parentAgentId =
        meta && meta.parentConvId !== sessionId ? meta.parentConvId : undefined;
      subagents.push({
        agentId: parsed.convId,
        agentType: meta?.agentType ?? '',
        description: meta?.description ?? '',
        ...(parentAgentId ? { parentAgentId } : {}),
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
  // Resolved per access so a settings.json change applies without a restart.
  get sourceDir() {
    return antigravitySourceDir();
  },
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  globalMemory,
  // `agy --conversation <id>` resumes a previous conversation by id (no CLI fork).
  resumeSpec: (id) => ({ resumeArgv: ['agy', '--conversation', id] }),
};
