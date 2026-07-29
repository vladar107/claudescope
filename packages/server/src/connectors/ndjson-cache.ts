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
import { writeFileSync } from 'node:fs';
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
export function ndjsonCache(agentId: string): NdjsonCache {
  const dir = join(CACHE_ROOT, agentId);
  // Standalone, not a `this.path` method call: callers may destructure the cache.
  const path = (sourcePath: string): string => {
    const hash = createHash('sha1').update(sourcePath).digest('hex').slice(0, 16);
    return join(dir, `${hash}.ndjson`);
  };
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
