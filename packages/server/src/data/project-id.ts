/**
 * Project identity helpers. A "project" is a distinct real `cwd`. The stable
 * id is a human-readable slug of the cwd followed by an 8-hex-char SHA-256
 * suffix derived from the full cwd. The slug makes ids readable in URLs and
 * logs; the hash suffix ensures uniqueness even when distinct paths produce
 * the same slug (e.g. `/a/b-c` and `/a/b/c` both slug to `a-b-c`). The
 * display name is the last meaningful path segment.
 */

import { createHash } from 'node:crypto';

/**
 * The leftmost `<sep>.claude<sep>worktrees<sep><name>` segment and everything
 * after it. Claude Code (CLI `--worktree`, subagent `isolation: "worktree"`,
 * and the desktop app's default) creates worktrees at
 * `<repo>/.claude/worktrees/<name>`, so stripping this folds a worktree cwd
 * into its repo. One source for both engines: {@link projectCwdFromCwd} (JS)
 * and {@link projectCwdSql} (DuckDB's RE2) must never disagree.
 */
export const WORKTREE_FOLD_PATTERN = String.raw`[/\\]\.claude[/\\]worktrees[/\\][^/\\]+.*$`;

const WORKTREE_FOLD = new RegExp(WORKTREE_FOLD_PATTERN);

/** The project cwd a session cwd belongs to: a Claude Code worktree folds into
 *  its repo. A fold that would leave nothing (`/.claude/worktrees/x`) keeps the input. */
export function projectCwdFromCwd(cwd: string): string {
  return cwd.replace(WORKTREE_FOLD, '') || cwd;
}

/** SQL twin of {@link projectCwdFromCwd} over a VARCHAR column expression.
 *  The pattern is quoted inline because it holds no `'`; importing `sqlString`
 *  would load the db config here, before tests that import this module
 *  statically get to point it at a sandbox. */
export function projectCwdSql(col: string): string {
  return `COALESCE(NULLIF(regexp_replace(${col}, '${WORKTREE_FOLD_PATTERN}', ''), ''), ${col})`;
}

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

/** Human-friendly project name: the last non-empty path segment of the cwd.
 *  Splits on both `/` and `\` so Windows cwds (`C:\Users\me\proj`) name correctly. */
export function displayNameFromCwd(cwd: string): string {
  const segments = cwd.split(/[/\\]/).filter(Boolean);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : cwd;
}
