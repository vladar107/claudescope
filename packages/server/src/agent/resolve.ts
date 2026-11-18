/**
 * Session matching for `claudescope resolve` — which session (or project) a
 * terminal pane belongs to, given an agent session id and/or a working
 * directory. Pure: the command in `query.ts` fetches the projects list, the
 * live list, and the exact-id / newest-session lookups, and these functions
 * decide. Path canonicalization (realpath) is injected so tests need no fs.
 */

import type { LiveSession, ProjectMeta, SessionMeta } from '@claudescope/shared';

export type ResolveMatch = 'id' | 'live' | 'recent' | 'ambiguous' | 'none';

export interface ResolveProject {
  id: string;
  cwd: string;
  /** `exact` when the cwd (or the session id) names the project itself; `ancestor` for a subdirectory. */
  match: 'exact' | 'ancestor';
}

export interface ResolveCandidate {
  meta: SessionMeta;
  live: boolean;
}

/** `claudescope resolve --json` output. */
export interface ResolveResult {
  match: ResolveMatch;
  project: ResolveProject | null;
  sessions: ResolveCandidate[];
}

/** Drop trailing separators (but keep a bare root). */
const trimSep = (p: string): string => p.replace(/(?<=.)[/\\]+$/, '');

const isRoot = (p: string): boolean => /^(?:[/\\]|[A-Za-z]:[/\\]?)$/.test(p);

/** True when `dir` is `p` or one of its ancestors, compared by whole path segments. */
function containsPath(dir: string, p: string): boolean {
  if (p === dir) return true;
  if (!p.startsWith(dir)) return false;
  const next = p[dir.length];
  return next === '/' || next === '\\';
}

const segmentCount = (p: string): number => p.split(/[/\\]/).filter(Boolean).length;

/**
 * The distinct spellings a path is compared under: as given (trailing
 * separators dropped) and canonicalized. Both are kept because a project cwd
 * that no longer exists on disk can only be compared as recorded, while the
 * caller's cwd may be a symlinked spelling of it (macOS `/tmp` vs `/private/tmp`).
 */
function pathForms(p: string, canon: (p: string) => string): string[] {
  const raw = trimSep(p);
  const real = trimSep(canon(raw));
  return real === raw ? [raw] : [raw, real];
}

/**
 * The project a working directory belongs to: the project whose cwd equals it,
 * else the nearest ancestor project (by path segments, so `/a/foo` never claims
 * `/a/foobar`). An ancestor that is the home directory or the filesystem root
 * is too broad to mean anything and does not count. Ties (two recorded
 * spellings of one directory) go to the most recently active project.
 *
 * @param cwd   absolute working directory
 * @param home  the user's home directory
 * @param canon realpath-like canonicalizer; must not throw
 */
export function matchProject(
  projects: readonly ProjectMeta[],
  cwd: string,
  home: string,
  canon: (p: string) => string = (p) => p,
): ResolveProject | null {
  const target = pathForms(cwd, canon);
  const homeForms = new Set(pathForms(home, canon));

  let best: { project: ProjectMeta; exact: boolean; depth: number } | null = null;
  for (const project of projects) {
    if (!project.cwd) continue;
    for (const form of pathForms(project.cwd, canon)) {
      for (const t of target) {
        if (!containsPath(form, t)) continue;
        const exact = form === t;
        if (!exact && (isRoot(form) || homeForms.has(form))) continue;
        const depth = segmentCount(form);
        const better =
          !best ||
          (exact && !best.exact) ||
          (exact === best.exact &&
            (depth > best.depth || (depth === best.depth && project.lastActive > best.project.lastActive)));
        if (better) best = { project, exact, depth };
      }
    }
  }
  return best ? { id: best.project.id, cwd: best.project.cwd, match: best.exact ? 'exact' : 'ancestor' } : null;
}

/**
 * Result for a `--session` id the index knows: the session itself, with its
 * project taken from `meta.projectId` (null only when that project is not
 * listed, e.g. a session with no recorded cwd).
 *
 * A caller's id can be stale: a terminal integration may keep reporting the
 * session a pane started with after the agent moved on to a new one (Claude
 * Code's `/clear` starts a new session id). So an id whose session is not live
 * while others in its project are is `ambiguous`: those live sessions first,
 * newest first, then the id's own session.
 */
export function resolveById(
  meta: SessionMeta,
  projects: readonly ProjectMeta[],
  live: readonly LiveSession[],
): ResolveResult {
  const listed = projects.find((p) => p.id === meta.projectId);
  const project: ResolveProject | null = listed ? { id: listed.id, cwd: listed.cwd, match: 'exact' } : null;
  const isLive = live.some((l) => l.meta.id === meta.id);
  const others = project && !isLive ? liveInProject(project, live) : [];
  if (others.length > 0) {
    return {
      match: 'ambiguous',
      project,
      sessions: [...others.map((l) => ({ meta: l.meta, live: true })), { meta, live: false }],
    };
  }
  return { match: 'id', project, sessions: [{ meta, live: isLive }] };
}

/** Live sessions of a project, newest write first. */
export function liveInProject(project: ResolveProject, live: readonly LiveSession[]): LiveSession[] {
  return live.filter((l) => l.meta.projectId === project.id).sort((a, b) => b.lastWriteMs - a.lastWriteMs);
}

/**
 * Result for a matched (or unmatched) project: one live session → `live`,
 * several → `ambiguous` (newest first), none → the project's newest session
 * (`recent`), and nothing at all → `none`.
 *
 * @param recent the project's newest session; only consulted when none is live
 */
export function resolveByProject(
  project: ResolveProject | null,
  live: readonly LiveSession[],
  recent?: SessionMeta,
): ResolveResult {
  if (!project) return { match: 'none', project: null, sessions: [] };
  const inProject = liveInProject(project, live);
  if (inProject.length === 1) {
    return { match: 'live', project, sessions: inProject.map((l) => ({ meta: l.meta, live: true })) };
  }
  if (inProject.length > 1) {
    return { match: 'ambiguous', project, sessions: inProject.map((l) => ({ meta: l.meta, live: true })) };
  }
  if (recent) return { match: 'recent', project, sessions: [{ meta: recent, live: false }] };
  return { match: 'none', project, sessions: [] };
}
