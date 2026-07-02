/**
 * Shared symlink-safe image inlining for connectors.
 *
 * Several connectors inline transcript-referenced images as base64 blocks. The
 * referenced path/name comes from transcript content, so it is UNTRUSTED: a
 * poisoned session dir could use `../../` traversal or — subtler — plant a
 * symlink whose textual path sits inside the allowed directory but whose target
 * is anywhere on disk (`statSync`/`readFileSync` follow symlinks). This helper
 * closes both holes with one rule, generalized from the Junie connector's
 * containment pattern: resolve the REAL path of both the trusted root and the
 * candidate, and refuse to read anything that does not resolve to inside the
 * root. A symlink is fine only while its target stays within the root.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, sep } from 'node:path';
import type { ImageBlock } from '@claudescope/shared';

/** Refuse to inline anything bigger than this (keeps API payloads sane). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Media types we will inline, keyed by lowercase extension (with dot). */
export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Read `candidatePath` as a base64 `ImageBlock`, but only if its REAL path
 * stays inside `rootDir` (real paths compared, so neither traversal nor a
 * symlink escaping the root can leak a file). Returns null for a non-image
 * extension, a missing/unreadable/oversized file, or a containment violation.
 */
export function resolveImageWithin(rootDir: string, candidatePath: string): ImageBlock | null {
  const mime = IMAGE_MIME[extname(candidatePath).toLowerCase()];
  if (!mime) return null; // not an image we inline
  let root: string;
  let real: string;
  try {
    root = realpathSync(rootDir);
    real = realpathSync(candidatePath);
  } catch {
    return null; // root or image missing, unreadable, or a broken symlink — skip
  }
  if (real !== root && !real.startsWith(root + sep)) return null; // escapes the root — refuse
  try {
    if (statSync(real).size > MAX_IMAGE_BYTES) return null;
    const data = readFileSync(real).toString('base64');
    return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  } catch {
    return null; // unreadable after resolution — skip
  }
}
