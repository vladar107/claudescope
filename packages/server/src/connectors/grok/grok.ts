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

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { grokSessionsDir } from '../../settings.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { canonicalProjectionSql, titlesProjectionSql } from '../canonical.js';
import { ndjsonCache } from '../ndjson-cache.js';
import { parentSessionDirOf, parseGrokSession, subagentMetas, toCanonicalRows } from './normalize.js';

const cache = ndjsonCache('grok');

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
  const sessionsDir = grokSessionsDir(); // resolve once per pass
  const out: DiscoveredFile[] = [];
  let cwdDirs: import('node:fs').Dirent[];
  try {
    cwdDirs = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return out; // no Grok install
  }
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    let sessionDirs: import('node:fs').Dirent[];
    try {
      sessionDirs = readdirSync(join(sessionsDir, cwdDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const chatPath = join(sessionsDir, cwdDir.name, sessionDir.name, 'chat_history.jsonl');
      const st = foldedStat(chatPath);
      if (st) out.push({ path: chatPath, ...st });
    }
  }
  return out;
}

/** Normalize a session to canonical NDJSON the projection will read. */
async function prepare(filePath: string): Promise<void> {
  const session = parseGrokSession(filePath);
  const rows = session ? toCanonicalRows(session, filePath) : [];
  cache.write(filePath, rows);
}

function eventsProjectionSql(filePath: string): string {
  return canonicalProjectionSql(cache.path(filePath), { provider: false });
}

/** Grok carries a real session title (summary.json `generated_title`), threaded
 *  through the cache NDJSON; the first-user-message fallback applies when empty. */
function auxProjections(filePath: string): AuxProjections {
  if (!existsSync(cache.path(filePath))) return {};
  return { titles: titlesProjectionSql(cache.path(filePath)) };
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
  // Resolved per access so a settings.json change applies without a restart.
  get sourceDir() {
    return grokSessionsDir();
  },
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
