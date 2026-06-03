/**
 * Project identity helpers. A "project" is a distinct real `cwd`. The stable
 * id is a slug of the cwd (so it survives URL round-trips and matches the
 * encoded-dir style without the lossiness), and the display name is the last
 * meaningful path segment.
 */

/** Derive a stable, URL-safe project id from a real cwd. */
export function projectIdFromCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Human-friendly project name: the last non-empty path segment of the cwd. */
export function displayNameFromCwd(cwd: string): string {
  const segments = cwd.split('/').filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : cwd;
}
