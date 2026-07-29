/**
 * The per-agent NDJSON cache used by every connector that normalizes in TS.
 *
 * Seven connectors had a byte-identical copy of this: a `CACHE_DIR` under
 * `~/.claudescope/cache/<agent>`, a `cachePath()` that sha1s the source path, and
 * a `prepare()` that mkdir'd and wrote the rows. Factored out so the cache layout
 * — and anything that needs to reason about it, such as pruning entries whose
 * source file is gone — has one owner.
 */

import { createHash } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDESCOPE_HOME, ensureStateDir } from '../config.js';
import type { CanonicalRow } from './canonical.js';

/** Root of the normalize cache. Everything under it is derived and rebuildable. */
const CACHE_ROOT = join(CLAUDESCOPE_HOME, 'cache');

export interface NdjsonCache {
  /** Deterministic cache path for a source file (or synthetic key). */
  path(sourcePath: string): string;
  /** Normalize + write, replacing whatever was there. */
  write(sourcePath: string, rows: CanonicalRow[]): void;
}

/**
 * The cache for one agent. `path()` is a sha1 of the source path truncated to
 * 16 hex chars — deterministic, filesystem-safe, and short enough to stay
 * readable; opencode relies on it accepting its synthetic `<db>#<id>` keys, which
 * aren't valid filenames.
 */
/** The cache filename a source path maps to. The layout's one naming rule. */
function cacheFileName(sourcePath: string): string {
  return `${createHash('sha1').update(sourcePath).digest('hex').slice(0, 16)}.ndjson`;
}

/**
 * Delete cache entries whose source file is no longer indexed.
 *
 * These files hold the normalized transcript **verbatim** — prompts, responses,
 * tool output, and whatever secrets happened to appear in them. Nothing used to
 * remove them: not the indexer's removed-file prune (which only deleted DB rows),
 * not "Rebuild index" (which only discards `index.duckdb*`), and no CLI command.
 * So deleting a session from `~/.codex` left Claudescope's plaintext copy on disk
 * indefinitely, and the directory grew without bound.
 *
 * Sweeping (rather than deleting one entry as its source disappears) also heals
 * orphans already on disk — from earlier versions, or from a crash between
 * `prepare()` and the load.
 *
 * `live` maps an agent id to the source paths that agent currently owns. An agent
 * ABSENT from the map is skipped entirely, which is how the caller protects a
 * connector whose discovery just failed: its files are missing this pass, but
 * that is transient, not a deletion. Returns the number of files removed.
 */
export function pruneNdjsonCaches(live: Map<string, Iterable<string>>): number {
  let removed = 0;
  for (const [agentId, sourcePaths] of live) {
    const dir = join(CACHE_ROOT, agentId);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // no cache dir for this agent (e.g. it needs no prepare())
    }
    const keep = new Set<string>();
    for (const p of sourcePaths) keep.add(cacheFileName(p));
    for (const entry of entries) {
      if (!entry.endsWith('.ndjson') || keep.has(entry)) continue;
      try {
        rmSync(join(dir, entry), { force: true });
        removed += 1;
      } catch {
        /* best-effort: a file we can't remove must not fail the pass */
      }
    }
  }
  return removed;
}

export function ndjsonCache(agentId: string): NdjsonCache {
  const dir = join(CACHE_ROOT, agentId);
  // Standalone, not a `this.path` method call: callers may destructure the cache.
  const path = (sourcePath: string): string => join(dir, cacheFileName(sourcePath));
  return {
    path,
    write(sourcePath: string, rows: CanonicalRow[]): void {
      // Owner-only, like the rest of the state dir: these files hold transcript
      // text verbatim (see the state-dir rules in CLAUDE.md).
      ensureStateDir(dir);
      writeFileSync(path(sourcePath), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    },
  };
}
