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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemorySource } from '@claudescope/shared';
import { junieHome, junieSessionsDir } from '../../settings.js';
import { contractHome } from '../../util/paths.js';
import type { SessionData } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { canonicalProjectionSql, titlesProjectionSql } from '../canonical.js';
import { ndjsonCache } from '../ndjson-cache.js';
import { parseSession, toCanonicalRows } from './normalize.js';

const cache = ndjsonCache('junie');

/**
 * One `DiscoveredFile` per session listed in `index.jsonl`, pointing at that
 * session's `events.jsonl`. Reading from the index (rather than walking dirs)
 * mirrors how Junie itself enumerates sessions and skips stray subdirectories.
 */
function discover(): DiscoveredFile[] {
  const sessionsDir = junieSessionsDir(); // resolve once per pass
  const indexPath = join(sessionsDir, 'index.jsonl');
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
    // sessionId is used to build a filesystem path, so reject anything from a
    // poisoned index.jsonl that could escape the sessions dir (separators or a
    // traversal segment). Real Junie ids are a single plain `session-…` segment.
    if (!sessionId || /[/\\]/.test(sessionId) || sessionId === '.' || sessionId === '..') continue;
    const full = join(sessionsDir, sessionId, 'events.jsonl');
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
  const rows = session ? toCanonicalRows(session, filePath) : [];
  cache.write(filePath, rows);
}

function eventsProjectionSql(filePath: string): string {
  return canonicalProjectionSql(cache.path(filePath), { provider: false });
}

/** Junie has an explicit session title (taskName); no PR links. */
function auxProjections(filePath: string): AuxProjections {
  if (!existsSync(cache.path(filePath))) return {};
  return { titles: titlesProjectionSql(cache.path(filePath)) };
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
  const agentsPath = join(junieHome(), 'AGENTS.md');
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
  // Resolved per access so a settings.json change applies without a restart.
  get sourceDir() {
    return junieSessionsDir();
  },
  discover,
  prepare,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  globalMemory,
  // Junie CLI resumes by id; it has no command-line fork, so resume only.
  resumeSpec: (id) => ({ resumeArgv: ['junie', '--session-id', id] }),
};
