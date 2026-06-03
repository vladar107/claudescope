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
  it('slugs a cwd into a URL-safe id', () => {
    expect(projectIdFromCwd('/Users/me/src/my-proj')).toBe('Users-me-src-my-proj');
  });

  it('collapses runs of non-alphanumerics and trims edges', () => {
    expect(projectIdFromCwd('/a//b__c')).toBe('a-b-c');
  });

  it('is stable for the same cwd', () => {
    const cwd = '/Users/x/src/languages-migration';
    expect(projectIdFromCwd(cwd)).toBe(projectIdFromCwd(cwd));
  });
});

describe('displayNameFromCwd', () => {
  it('returns the last path segment', () => {
    expect(displayNameFromCwd('/Users/me/src/my-proj')).toBe('my-proj');
  });

  it('falls back to the cwd when there are no segments', () => {
    expect(displayNameFromCwd('/')).toBe('/');
  });
});
