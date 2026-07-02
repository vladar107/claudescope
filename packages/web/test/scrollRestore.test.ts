import { describe, expect, it } from 'vitest';
import { parseSavedPlace, resolveAnchor } from '../src/pages/session/useScrollRestore.js';

describe('parseSavedPlace', () => {
  it('accepts a well-formed place', () => {
    expect(parseSavedPlace('{"uuid":"u1","index":3,"delta":-42.5}')).toEqual({
      uuid: 'u1',
      index: 3,
      delta: -42.5,
    });
  });

  it('rejects null and malformed JSON', () => {
    expect(parseSavedPlace(null)).toBeNull();
    expect(parseSavedPlace('')).toBeNull();
    expect(parseSavedPlace('{"uuid":')).toBeNull();
  });

  it('rejects wrong shapes and non-finite numbers', () => {
    expect(parseSavedPlace('"u1"')).toBeNull();
    expect(parseSavedPlace('{"uuid":"","index":0,"delta":0}')).toBeNull();
    expect(parseSavedPlace('{"uuid":"u1","index":"3","delta":0}')).toBeNull();
    expect(parseSavedPlace('{"uuid":"u1","index":-1,"delta":0}')).toBeNull();
    expect(parseSavedPlace('{"uuid":"u1","index":0,"delta":null}')).toBeNull();
    expect(parseSavedPlace('{"uuid":"u1","index":0}')).toBeNull();
  });
});

describe('resolveAnchor', () => {
  const items = [{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }];
  const indexByUuid = new Map(items.map((it, i) => [it.uuid, i]));

  it('resolves an existing uuid exactly', () => {
    expect(resolveAnchor({ uuid: 'b', index: 1, delta: 0 }, indexByUuid, items)).toEqual({
      uuid: 'b',
      exact: true,
    });
  });

  it('falls back to the saved index when the uuid is gone', () => {
    expect(resolveAnchor({ uuid: 'gone', index: 1, delta: 0 }, indexByUuid, items)).toEqual({
      uuid: 'b',
      exact: false,
    });
  });

  it('clamps an out-of-range index to the last turn', () => {
    expect(resolveAnchor({ uuid: 'gone', index: 99, delta: 0 }, indexByUuid, items)).toEqual({
      uuid: 'c',
      exact: false,
    });
  });

  it('returns null for an empty session', () => {
    expect(resolveAnchor({ uuid: 'gone', index: 0, delta: 0 }, new Map(), [])).toBeNull();
  });
});
