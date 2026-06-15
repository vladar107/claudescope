/**
 * Unit tests for the daemon-lifecycle primitives in cli.ts — the project's first
 * CLI test. Covers the helpers that decide whether to reuse, clear, or replace a
 * recorded daemon, including the alive-but-unhealthy ("wedged") case that used to
 * fall through and spawn a conflicting server.
 *
 * CLAUDESCOPE_HOME is set before importing cli.js (config.ts reads env at import
 * time, and DAEMON_FILE/LOG_FILE derive from it). No real server is ever spawned;
 * process.kill and fetch are mocked.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- temp state dir (decided before importing the module under test) ---------
const work = mkdtempSync(join(tmpdir(), 'claudescope-cli-'));
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
process.env.CLAUDESCOPE_HOME = home;
const DAEMON_FILE = join(home, 'daemon.json');

const cli = await import('../src/cli.js');

const record = (over: Partial<import('../src/cli.js').DaemonRecord> = {}) => ({
  pid: 4242,
  port: 4317,
  url: 'http://localhost:4317',
  version: '1.2.3',
  startedAt: '2026-06-15T00:00:00.000Z',
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(DAEMON_FILE, { force: true });
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('classifyExisting', () => {
  const alive = () => true;
  const dead = () => false;
  const healthy = async () => true;
  const unhealthy = async () => false;

  it("returns 'none' when there is no record", async () => {
    expect(await cli.classifyExisting(null, alive, healthy)).toBe('none');
  });

  it("returns 'stale' when the recorded process is gone", async () => {
    expect(await cli.classifyExisting(record(), dead, healthy)).toBe('stale');
  });

  it("returns 'healthy' when the process is alive and the endpoint responds", async () => {
    expect(await cli.classifyExisting(record(), alive, healthy)).toBe('healthy');
  });

  it("returns 'wedged' when the process is alive but the endpoint is unresponsive", async () => {
    // The regression guard: this case must be distinguishable from 'stale' so
    // start() replaces the wedged process instead of spawning a conflicting one.
    expect(await cli.classifyExisting(record(), alive, unhealthy)).toBe('wedged');
  });
});

describe('isAlive', () => {
  it('probes with signal 0 and is true when kill does not throw', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(cli.isAlive(4242)).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });

  it('is false when kill throws (no such process)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    expect(cli.isAlive(4242)).toBe(false);
  });
});

describe('readDaemon', () => {
  it('parses a valid record', () => {
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    expect(cli.readDaemon()).toMatchObject({ pid: 4242, port: 4317 });
  });

  it('returns null when the file is absent', () => {
    expect(cli.readDaemon()).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    writeFileSync(DAEMON_FILE, '{ not valid json');
    expect(cli.readDaemon()).toBeNull();
  });
});

describe('isHealthy', () => {
  it('is true on an ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    expect(await cli.isHealthy(4317)).toBe(true);
  });

  it('is false on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await cli.isHealthy(4317)).toBe(false);
  });

  it('is false when fetch rejects (server down)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    expect(await cli.isHealthy(4317)).toBe(false);
  });
});

describe('waitForHealth', () => {
  it('retries until healthy', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: ++calls >= 2 })));
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cli.waitForHealth(4317, 5000)).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('gives up at the deadline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await cli.waitForHealth(4317, 300)).toBe(false);
  });
});

describe('waitForExit', () => {
  it('resolves true once the process is gone', async () => {
    let calls = 0;
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (++calls >= 2) throw new Error('ESRCH');
      return true;
    });
    expect(await cli.waitForExit(4242, 5000)).toBe(true);
  });

  it('resolves false if the process never exits within the budget', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(await cli.waitForExit(4242, 300)).toBe(false);
  });
});
