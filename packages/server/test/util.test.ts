import { describe, expect, it } from 'vitest';
import { sqlString } from '../src/db/duckdb.js';
import { displayNameFromCwd, projectIdFromCwd } from '../src/data/project-id.js';

describe('sqlString', () => {
  it('wraps a value in single quotes', () => {
    expect(sqlString('abc')).toBe("'abc'");
  });

  it('escapes embedded single quotes (injection safety)', () => {
    expect(sqlString("O'Brien")).toBe("'O''Brien'");
    expect(sqlString("'; DROP TABLE events; --")).toBe("'''; DROP TABLE events; --'");
  });

  it('handles empty strings', () => {
    expect(sqlString('')).toBe("''");
  });
});

describe('projectIdFromCwd', () => {
  it('slugs a cwd into a URL-safe id with hash suffix', () => {
    // slug: Users-me-src-my-proj, hash8: sha256('/Users/me/src/my-proj').slice(0,8) = ffb76eab
    expect(projectIdFromCwd('/Users/me/src/my-proj')).toBe('Users-me-src-my-proj-ffb76eab');
  });

  it('collapses runs of non-alphanumerics, trims edges, and appends hash', () => {
    // slug: a-b-c, hash8: sha256('/a//b__c').slice(0,8) = daf1542d
    expect(projectIdFromCwd('/a//b__c')).toBe('a-b-c-daf1542d');
  });

  it('is stable for the same cwd', () => {
    const cwd = '/Users/x/src/languages-migration';
    expect(projectIdFromCwd(cwd)).toBe(projectIdFromCwd(cwd));
  });

  it('is collision-resistant: distinct paths with identical slugs get different ids', () => {
    // Both slug to 'a-b-c' but differ in their hash suffix
    expect(projectIdFromCwd('/a/b-c')).not.toBe(projectIdFromCwd('/a/b/c'));
    // Both slug to 'tmp-foo-bar' but differ in their hash suffix
    expect(projectIdFromCwd('/tmp/foo-bar')).not.toBe(projectIdFromCwd('/tmp/foo_bar'));
  });
});

describe('displayNameFromCwd', () => {
  it('returns the last path segment', () => {
    expect(displayNameFromCwd('/Users/me/src/my-proj')).toBe('my-proj');
  });

  it('falls back to the cwd when there are no segments', () => {
    expect(displayNameFromCwd('/')).toBe('/');
  });

  it('handles Windows backslash separators (and a trailing slash)', () => {
    expect(displayNameFromCwd('C:\\Users\\me\\my-proj')).toBe('my-proj');
    expect(displayNameFromCwd('C:\\Users\\me\\my-proj\\')).toBe('my-proj');
  });
});
