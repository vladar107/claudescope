/**
 * `claudescope resolve` matching rules (agent/resolve.ts), without a daemon:
 * the live list depends on snapshot timing, so `live`/`ambiguous` are pinned
 * here and the integration test in cli-query.test.ts covers only id/recent/none.
 */

import { describe, expect, it } from 'vitest';
import type { LiveSession, ProjectMeta, SessionMeta } from '@claudescope/shared';
import { matchProject, resolveById, resolveByProject } from '../src/agent/resolve.js';

const HOME = '/Users/me';

function project(id: string, cwd: string, lastActive = '2026-01-01T00:00:00.000Z'): ProjectMeta {
  return {
    id,
    cwd,
    displayName: cwd.split('/').pop() ?? cwd,
    sessionCount: 1,
    totalTokens: 0,
    totalCostUsd: 0,
    lastActive,
    connectorIds: ['claude-code'],
    agents: [],
  };
}

function meta(id: string, projectId: string): SessionMeta {
  return {
    id,
    projectId,
    projectDisplayName: projectId,
    title: id,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 1,
    toolCallCount: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    models: [],
    providers: [],
    sizeBytes: 0,
    hasSidechain: false,
    connectorId: 'claude-code',
  };
}

function live(id: string, projectId: string, lastWriteMs: number): LiveSession {
  return {
    meta: meta(id, projectId),
    state: 'working',
    lastWriteMs,
    subagents: { running: 0, done: 0 },
    usageGranularity: 'per-response',
    runs: [],
  };
}

const PROJECTS = [
  project('foo', '/a/foo'),
  project('foobar', '/a/foobar'),
  project('home', HOME),
  project('root', '/'),
  project('app', `${HOME}/src/app`),
];

describe('matchProject', () => {
  it('matches the project whose cwd equals the directory, ignoring a trailing slash', () => {
    expect(matchProject(PROJECTS, '/a/foo/', HOME)).toEqual({ id: 'foo', cwd: '/a/foo', match: 'exact' });
  });

  it('takes the nearest ancestor project for a subdirectory', () => {
    expect(matchProject(PROJECTS, `${HOME}/src/app/packages/web`, HOME)).toEqual({
      id: 'app',
      cwd: `${HOME}/src/app`,
      match: 'ancestor',
    });
  });

  it('compares whole path segments: /a/foo never claims /a/foobar', () => {
    expect(matchProject(PROJECTS, '/a/foobar/x', HOME)?.id).toBe('foobar');
    expect(matchProject([project('foo', '/a/foo')], '/a/foobar', HOME)).toBeNull();
  });

  it('does not count the home directory as an ancestor', () => {
    expect(matchProject(PROJECTS, `${HOME}/scratch/thing`, HOME)).toBeNull();
    // ...but a pane sitting in $HOME itself is that project.
    expect(matchProject(PROJECTS, HOME, HOME)?.id).toBe('home');
  });

  it('does not count the filesystem root as an ancestor', () => {
    expect(matchProject(PROJECTS, '/opt/elsewhere', HOME)).toBeNull();
  });

  it('returns null for a directory under no project', () => {
    expect(matchProject([project('foo', '/a/foo')], '/b/bar', HOME)).toBeNull();
  });

  it('matches through a symlinked spelling of the directory (macOS /tmp → /private/tmp)', () => {
    const canon = (p: string): string => p.replace(/^\/tmp(?=\/|$)/, '/private/tmp');
    // Recorded under the symlink, asked under the real path, and vice versa.
    expect(matchProject([project('t', '/tmp/proj')], '/private/tmp/proj/sub', HOME, canon)).toEqual({
      id: 't',
      cwd: '/tmp/proj',
      match: 'ancestor',
    });
    expect(matchProject([project('p', '/private/tmp/proj')], '/tmp/proj', HOME, canon)?.match).toBe('exact');
  });
});

describe('resolveById', () => {
  it('returns the exact session with its project, flagged live when it is in the live list', () => {
    const res = resolveById(meta('s1', 'foo'), PROJECTS, [live('s1', 'foo', 1)]);
    expect(res).toEqual({
      match: 'id',
      project: { id: 'foo', cwd: '/a/foo', match: 'exact' },
      sessions: [{ meta: meta('s1', 'foo'), live: true }],
    });
    expect(resolveById(meta('s1', 'foo'), PROJECTS, []).sessions[0]?.live).toBe(false);
  });

  // A pane's integration can keep reporting the session it started with after
  // the agent began a new one (/clear): the id is idle while the pane's real
  // session is live in the same project.
  it('a non-live id while others in its project are live → ambiguous, live first, the id last', () => {
    const res = resolveById(meta('old', 'foo'), PROJECTS, [
      live('a', 'foo', 1),
      live('b', 'foo', 2),
      live('x', 'bar', 3),
    ]);
    expect(res.match).toBe('ambiguous');
    expect(res.sessions.map((s) => [s.meta.id, s.live])).toEqual([
      ['b', true],
      ['a', true],
      ['old', false],
    ]);
  });

  it('a non-live id with nothing else live in its project stays an id match', () => {
    expect(resolveById(meta('old', 'foo'), PROJECTS, [live('x', 'bar', 1)]).match).toBe('id');
  });
});

describe('resolveByProject', () => {
  const foo = { id: 'foo', cwd: '/a/foo', match: 'exact' } as const;

  it('one live session in the project → live', () => {
    const res = resolveByProject(foo, [live('s1', 'foo', 10), live('other', 'foobar', 99)]);
    expect(res.match).toBe('live');
    expect(res.sessions.map((s) => [s.meta.id, s.live])).toEqual([['s1', true]]);
  });

  it('several live sessions → ambiguous, newest write first', () => {
    const res = resolveByProject(foo, [live('older', 'foo', 10), live('newer', 'foo', 20)]);
    expect(res.match).toBe('ambiguous');
    expect(res.sessions.map((s) => s.meta.id)).toEqual(['newer', 'older']);
  });

  it('none live → the newest session, not live', () => {
    const res = resolveByProject(foo, [live('other', 'foobar', 99)], meta('latest', 'foo'));
    expect(res).toEqual({ match: 'recent', project: foo, sessions: [{ meta: meta('latest', 'foo'), live: false }] });
  });

  it('no project → none', () => {
    expect(resolveByProject(null, [live('s1', 'foo', 10)])).toEqual({ match: 'none', project: null, sessions: [] });
  });
});
