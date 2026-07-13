/**
 * Unit tests for update-check.ts: the x.y.z comparison that gates both the CLI
 * update notice and the daemon's `updateAvailable` nudge (pinning its
 * coercion of short/garbage/prerelease inputs), the 24h file-cache behavior of
 * the registry lookup, and the daemon-side cache exposed on /api/health.
 *
 * CLAUDESCOPE_HOME is set before importing the module (config.ts reads env at
 * import time). fetch is always stubbed — no test touches the network.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'claudescope-update-'));
process.env.CLAUDESCOPE_HOME = home;

const uc = await import('../src/update-check.js');
const CACHE = join(home, 'update-check.json');

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(CACHE, { force: true });
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('isNewer', () => {
  it('orders plain x.y.z versions', () => {
    expect(uc.isNewer('0.12.0', '0.11.9')).toBe(true);
    expect(uc.isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(uc.isNewer('0.11.0', '0.11.0')).toBe(false);
    expect(uc.isNewer('0.11.0', '0.12.0')).toBe(false);
  });

  it('coerces short, garbage, and prerelease segments to numbers (pinned)', () => {
    // Missing segments read as 0 …
    expect(uc.isNewer('0.12', '0.11.5')).toBe(true);
    // … garbage reads as 0.0.0 (never "newer" than a real release) …
    expect(uc.isNewer('abc', '0.0.1')).toBe(false);
    // … and a prerelease tail is ignored: parseInt('0-beta') === 0.
    expect(uc.isNewer('0.12.0-beta.2', '0.12.0')).toBe(false);
    expect(uc.isNewer('9.9.9', '0.0.0-dev')).toBe(true);
  });
});

describe('getLatestVersion', () => {
  it('serves a fresh cache without touching the network', async () => {
    writeFileSync(CACHE, JSON.stringify({ lastCheck: Date.now(), latest: '1.2.3' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('network must not be touched');
      }),
    );
    expect(await uc.getLatestVersion(false)).toBe('1.2.3');
  });

  it('refetches past the 24h TTL and rewrites the cache', async () => {
    writeFileSync(
      CACHE,
      JSON.stringify({ lastCheck: Date.now() - 25 * 60 * 60 * 1000, latest: '1.2.3' }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.3.0' }) })),
    );
    expect(await uc.getLatestVersion(false)).toBe('1.3.0');
    expect(JSON.parse(readFileSync(CACHE, 'utf8')).latest).toBe('1.3.0');
  });

  it('force bypasses even a fresh cache', async () => {
    writeFileSync(CACHE, JSON.stringify({ lastCheck: Date.now(), latest: '1.2.3' }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ version: '1.4.0' }) })),
    );
    expect(await uc.getLatestVersion(true)).toBe('1.4.0');
  });

  it('a corrupt cache file falls through to a fresh fetch', async () => {
    writeFileSync(CACHE, 'not json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ version: '2.0.0' }) })),
    );
    expect(await uc.getLatestVersion(false)).toBe('2.0.0');
  });

  it('a non-ok registry response yields null and writes no cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await uc.getLatestVersion(false)).toBeNull();
    expect(() => readFileSync(CACHE, 'utf8')).toThrow();
  });
});

// These run in order on purpose: cachedLatest is module-level daemon state.
describe('updateAvailable / refreshLatestVersion', () => {
  it('is null before any refresh', () => {
    expect(uc.updateAvailable()).toBeNull();
  });

  it('reports a newer published version after a refresh', async () => {
    writeFileSync(CACHE, JSON.stringify({ lastCheck: Date.now(), latest: '9.9.9' }));
    await uc.refreshLatestVersion();
    // APP_VERSION is 0.0.0-dev under vitest, so 9.9.9 is newer.
    expect(uc.updateAvailable()).toBe('9.9.9');
  });

  it('keeps the last-known value when the registry is unreachable', async () => {
    // No cache file and fetch rejecting — refresh must neither throw nor
    // clear the previously seen version.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await uc.refreshLatestVersion();
    expect(uc.updateAvailable()).toBe('9.9.9');
  });

  it('is null when the published version is not newer than this build', async () => {
    writeFileSync(CACHE, JSON.stringify({ lastCheck: Date.now(), latest: '0.0.0-dev' }));
    await uc.refreshLatestVersion();
    expect(uc.updateAvailable()).toBeNull();
  });
});
