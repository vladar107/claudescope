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
const daemon = await import('../src/daemon.js');

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

describe('fetchDaemonHealth', () => {
  it('parses the health payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'ok', version: '1.2.3', ready: true }),
      })),
    );
    expect(await daemon.fetchDaemonHealth(4317)).toMatchObject({ version: '1.2.3' });
  });

  it('is null on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    expect(await daemon.fetchDaemonHealth(4317)).toBeNull();
  });

  it('is null when fetch rejects (server down)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    expect(await daemon.fetchDaemonHealth(4317)).toBeNull();
  });

  it('is null on an unparsable body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error('invalid json');
        },
      })),
    );
    expect(await daemon.fetchDaemonHealth(4317)).toBeNull();
  });
});

describe('ensureDaemon version healing', () => {
  // Probes replace every process/network touch (classifyExisting precedent):
  // these tests never spawn or kill anything.
  const probes = (over: Partial<import('../src/daemon.js').DaemonProbes> = {}) => ({
    alive: () => true,
    healthy: async () => true,
    terminate: vi.fn(async () => {}),
    spawn: vi.fn(),
    waitHealthy: async () => true,
    ...over,
  });

  afterEach(() => {
    delete process.env.CLAUDESCOPE_AUTO_RESTART;
  });

  it('adopts a healthy daemon of the same version without touching it', async () => {
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const p = probes({
      health: async () => ({ status: 'ok' as const, version: '0.0.0-dev' }),
    });
    const d = await daemon.ensureDaemon(() => {}, p);
    expect(d).toMatchObject({ port: 4317, url: 'http://localhost:4317' });
    expect(p.terminate).not.toHaveBeenCalled();
    expect(p.spawn).not.toHaveBeenCalled();
  });

  it('restarts a healthy daemon whose version differs from this CLI', async () => {
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const p = probes({
      health: async () => ({ status: 'ok' as const, version: '9.9.9' }),
    });
    const d = await daemon.ensureDaemon(() => {}, p);
    expect(p.terminate).toHaveBeenCalledOnce();
    expect(p.spawn).toHaveBeenCalledOnce();
    expect(d.port).toBe(4317);
  });

  it('a skew heal respawns on the daemon’s original port, not the default', async () => {
    // A user-chosen --port must survive an MCP/query heal — relocating the
    // daemon to 4317 would strand the record and the user's bookmarks.
    writeFileSync(
      DAEMON_FILE,
      JSON.stringify(record({ port: 5000, url: 'http://localhost:5000' })),
    );
    const p = probes({
      health: async () => ({ status: 'ok' as const, version: '9.9.9' }),
    });
    const d = await daemon.ensureDaemon(() => {}, p);
    expect(p.spawn).toHaveBeenCalledWith(5000);
    expect(d).toMatchObject({ port: 5000, url: 'http://localhost:5000' });
  });

  it('CLAUDESCOPE_AUTO_RESTART=0 warns and adopts the skewed daemon', async () => {
    process.env.CLAUDESCOPE_AUTO_RESTART = '0';
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const logs: string[] = [];
    const p = probes({
      health: async () => ({ status: 'ok' as const, version: '9.9.9' }),
    });
    const d = await daemon.ensureDaemon((m) => logs.push(m), p);
    expect(d).toMatchObject({ port: 4317, url: 'http://localhost:4317' });
    expect(p.terminate).not.toHaveBeenCalled();
    expect(p.spawn).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('v9.9.9');
    expect(logs.join('\n')).toContain('claudescope restart');
  });

  it('a health probe failure (null) is treated as no-skew and adopts', async () => {
    // The daemon was healthy a moment ago; a race on the second fetch must not
    // trigger a restart of a perfectly good process.
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const p = probes({ health: async () => null });
    const d = await daemon.ensureDaemon(() => {}, p);
    expect(d.port).toBe(4317);
    expect(p.terminate).not.toHaveBeenCalled();
  });
});
