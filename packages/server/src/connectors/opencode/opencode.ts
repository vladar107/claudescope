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

import { existsSync } from 'node:fs';
import { opencodeDataDir, opencodeDbPath } from '../../settings.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { canonicalProjectionSql, titlesProjectionSql } from '../canonical.js';
import { ndjsonCache } from '../ndjson-cache.js';
import { listSessions, readSession, statSession } from './db.js';
import { buildEvents, taskSpawns, toCanonicalRows } from './normalize.js';

const cache = ndjsonCache('opencode');

/** Synthetic per-session key → its DB path + session id. opencode ids are
 *  `ses_<base62>` (no `#`), so splitting on the first `#` is unambiguous. */
function parseKey(filePath: string): { dbPath: string; sessionId: string } {
  const i = filePath.indexOf('#');
  return i === -1
    ? { dbPath: filePath, sessionId: '' }
    : { dbPath: filePath.slice(0, i), sessionId: filePath.slice(i + 1) };
}

/**
 * One synthetic `DiscoveredFile` per session, with the change signal from
 * {@link listSessions}. Returns `[]` when the DB is absent; **throws** when the
 * DB exists but can't be read, so the indexer never mistakes a transient SQLite
 * failure for "all opencode sessions deleted" (the indexer isolates a throwing
 * connector and preserves its prior files — see `data/index.ts`).
 */
function discover(): DiscoveredFile[] {
  const dbPath = opencodeDbPath(); // resolve once per pass
  return listSessions(dbPath).map((s) => ({
    path: `${dbPath}#${s.id}`,
    mtimeMs: s.mtimeMs,
    size: s.size,
  }));
}

/** Extract one session from the DB to a canonical NDJSON the projection reads. */
async function prepare(filePath: string): Promise<void> {
  const { dbPath, sessionId } = parseKey(filePath);
  const session = readSession(dbPath, sessionId);
  const rows = session ? toCanonicalRows(session, filePath) : [];
  cache.write(filePath, rows);
}

function eventsProjectionSql(filePath: string): string {
  return canonicalProjectionSql(cache.path(filePath), { provider: true });
}

/** opencode stores a real per-session title; carried through the cache NDJSON. */
function auxProjections(filePath: string): AuxProjections {
  if (!existsSync(cache.path(filePath))) return {};
  return { titles: titlesProjectionSql(cache.path(filePath)) };
}

/**
 * Load a session's events, splitting the resolved synthetic files into the main
 * transcript (its id equals the session id) and one subagent per re-parented
 * task-spawned child. Children are labeled from the spawning session's `task`
 * parts (matched via `state.metadata.sessionId`) so each run anchors to its Task
 * block — scanned across every resolved session, since a subagent that spawns a
 * subagent holds the grandchild's `task` part in its OWN transcript.
 */
async function loadSession(sessionId: string, paths: string[]): Promise<SessionData> {
  const sessions = [...paths]
    .sort()
    .map((p) => {
      const { dbPath, sessionId: id } = parseKey(p);
      return readSession(dbPath, id);
    })
    .filter((s): s is NonNullable<typeof s> => s != null);

  const main = sessions.filter((s) => s.id === sessionId);
  const mainEvents = main.flatMap(buildEvents);
  const spawns = new Map(sessions.flatMap((s) => [...taskSpawns(s)]));
  const subagents: SubagentSource[] = sessions
    .filter((s) => s.id !== sessionId)
    .map((s) => ({
      agentId: s.id,
      agentType: spawns.get(s.id)?.agentType ?? '',
      // No matching task part (orphan) or an empty description → the child's
      // own title; it renders detached rather than anchored, which is the
      // honest state, but at least carries a human-readable label.
      description: spawns.get(s.id)?.description || s.title,
      // Only a spawning session that is itself a child is passed on — the root
      // is implied, and it scopes matching to that run's own `task` calls.
      ...(s.parentId && s.parentId !== sessionId ? { parentAgentId: s.parentId } : {}),
      events: buildEvents(s),
    }));

  // Fallback: the parent session row is gone while re-parented children still
  // resolve under its id — promote them so the thread isn't empty.
  if (mainEvents.length === 0 && subagents.length > 0) {
    return { mainEvents: subagents.flatMap((s) => s.events), subagents: [] };
  }
  return { mainEvents, subagents };
}

export const opencodeConnector: AgentConnector = {
  id: 'opencode',
  label: 'opencode',
  // Resolved per access so a settings.json change applies without a restart.
  get sourceDir() {
    return opencodeDataDir();
  },
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  // Synthetic `<dbPath>#<id>` paths can't be fs.stat'ed — probe the DB instead.
  statFile: (filePath) => {
    const { dbPath, sessionId } = parseKey(filePath);
    return sessionId ? statSession(dbPath, sessionId) : null;
  },
  resumeSpec: (id) => ({
    resumeArgv: ['opencode', '--session', id],
    forkArgv: ['opencode', '--session', id, '--fork'],
  }),
};
