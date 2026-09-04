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

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { copilotSessionsDir } from '../../settings.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { canonicalProjectionSql, compactionsProjectionSql, titlesProjectionSql } from '../canonical.js';
import { ndjsonCache } from '../ndjson-cache.js';
import { parseCopilotSession, toCanonicalRows, type CopilotSession } from './normalize.js';
import { copilotGlobalMemory } from './memory.js';

const cache = ndjsonCache('copilot');

/** Collect every `<uuid>/events.jsonl` under the Copilot session-state dir. */
function discover(): DiscoveredFile[] {
  const sessionsDir = copilotSessionsDir(); // resolve once per pass
  const out: DiscoveredFile[] = [];
  let dirs: import('node:fs').Dirent[];
  try {
    dirs = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return out; // no Copilot install
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const full = join(sessionsDir, dir.name, 'events.jsonl');
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
  const rows = session ? toCanonicalRows(session, filePath) : [];
  cache.write(filePath, rows);
}

function eventsProjectionSql(filePath: string): string {
  return canonicalProjectionSql(cache.path(filePath), { provider: false });
}

/** Copilot carries a real session title (workspace.yaml `name`), threaded through
 *  the cache NDJSON alongside its compaction markers; the first-user-message
 *  fallback applies when the title is empty. */
function auxProjections(filePath: string): AuxProjections {
  if (!existsSync(cache.path(filePath))) return {};
  return {
    titles: titlesProjectionSql(cache.path(filePath)),
    compactions: compactionsProjectionSql(cache.path(filePath)),
  };
}

async function loadSession(_sessionId: string, paths: string[]): Promise<SessionData> {
  // resolveImages: pull saved-attachment bytes off disk for the detail view.
  const sessions = paths
    .map((p) => parseCopilotSession(p, { resolveImages: true }))
    .filter((s): s is CopilotSession => s !== null);
  const mainEvents = sessions.flatMap((s) => s.events);
  // Inline subagent runs, segmented out by the normalizer. `agentId` IS the
  // spawning `task` toolCallId — the exact id of its canonical `Task` block —
  // and `parentAgentId` names the run that made the call when a subagent
  // spawned this one.
  const subagents: SubagentSource[] = sessions.flatMap((s) =>
    s.subagents.map((sub) => ({
      agentId: sub.agentId,
      agentType: sub.agentType,
      description: sub.description,
      toolUseId: sub.agentId,
      ...(sub.parentAgentId ? { parentAgentId: sub.parentAgentId } : {}),
      events: sub.events,
    })),
  );
  return { mainEvents, subagents };
}

export const copilotConnector: AgentConnector = {
  id: 'copilot',
  label: 'GitHub Copilot CLI',
  // Resolved per access so a settings.json change applies without a restart.
  get sourceDir() {
    return copilotSessionsDir();
  },
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  globalMemory: copilotGlobalMemory,
  // Copilot CLI has no command-line fork (only an in-session `/fork`), so resume only.
  resumeSpec: (id) => ({ resumeArgv: ['copilot', '--resume', id] }),
};
