/**
 * Project identity helpers. A "project" is a distinct real `cwd`. The stable
 * id is a human-readable slug of the cwd followed by an 8-hex-char SHA-256
 * suffix derived from the full cwd. The slug makes ids readable in URLs and
 * logs; the hash suffix ensures uniqueness even when distinct paths produce
 * the same slug (e.g. `/a/b-c` and `/a/b/c` both slug to `a-b-c`). The
 * display name is the last meaningful path segment.
 */

import { createHash } from 'node:crypto';

/** Derive a stable, URL-safe, collision-resistant project id from a real cwd.
 *
 * Format: `<slug>-<hash8>` where slug collapses non-alphanumeric runs to `-`
 * and hash8 is the first 8 hex characters of the SHA-256 of the full cwd.
 * If the slug is empty (e.g. cwd is `/`), returns just the hash.
 */
export function projectIdFromCwd(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const hash8 = createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  return slug ? `${slug}-${hash8}` : hash8;
}

/** Human-friendly project name: the last non-empty path segment of the cwd. */
export function displayNameFromCwd(cwd: string): string {
  const segments = cwd.split('/').filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : cwd;
}
