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
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Only `spawn` is faked (spawnDaemon must not launch a real server); the rest of
// the module stays real — daemonOwnsPid's execFileSync probe is under test too.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

// --- temp state dir (decided before importing the module under test) ---------
const work = mkdtempSync(join(tmpdir(), 'claudescope-cli-'));
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
process.env.CLAUDESCOPE_HOME = home;
const DAEMON_FILE = join(home, 'daemon.json');

const cli = await import('../src/cli.js');
const daemon = await import('../src/daemon.js');
const { APP_VERSION } = await import('../src/config.js');

const record = (over: Partial<import('../src/cli.js').DaemonRecord> = {}) => ({
  pid: 4242,
  port: 4317,
  url: 'http://localhost:4317',
  version: '1.2.3',
  startedAt: '2026-06-15T00:00:00.000Z',
  ...over,
});

/** A terminate probe that reports the daemon was ours and is gone. */
const terminateProbe = () =>
  vi.fn(async (): Promise<import('../src/daemon.js').WedgeAction> => ({ kind: 'replace' }));

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
    owns: () => true as boolean | 'unknown',
    healthy: async () => true,
    terminate: terminateProbe(),
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

  it('adopts a skewed daemon when its PID cannot be verified, rather than failing', async () => {
    // Only killing needs certainty: the daemon just answered /api/health, and a
    // machine without `ps` must not lose every MCP/query call over a version gap.
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const logs: string[] = [];
    const p = probes({
      health: async () => ({ status: 'ok' as const, version: '9.9.9' }),
      terminate: vi.fn(async () => ({ kind: 'refuse' as const, message: 'could not verify pid 4242' })),
    });
    const d = await daemon.ensureDaemon((m) => logs.push(m), p);
    expect(d).toMatchObject({ port: 4317, url: 'http://localhost:4317' });
    expect(p.spawn).not.toHaveBeenCalled();
    expect(existsSync(DAEMON_FILE)).toBe(true);
    expect(logs.join('\n')).toContain('could not verify pid 4242');
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

describe('wedged-daemon ownership (never SIGTERM a PID we do not own)', () => {
  // A crash leaves daemon.json behind; if the OS reuses that PID, "alive but the
  // port is silent" describes an UNRELATED process just as well as our hung
  // daemon. planWedgeAction is the gate — these pin each verdict's action.
  it('replaces the daemon when the PID is confirmed ours', () => {
    expect(daemon.planWedgeAction(record(), true)).toEqual({ kind: 'replace' });
  });

  it('discards the record — without signalling — when the PID is someone else', () => {
    const action = daemon.planWedgeAction(record(), false);
    expect(action.kind).toBe('discard');
    expect(action.kind !== 'replace' && action.message).toMatch(/PID was reused/i);
  });

  it('refuses to signal when ownership cannot be determined', () => {
    const action = daemon.planWedgeAction(record(), 'unknown');
    expect(action.kind).toBe('refuse');
    // The message has to tell the user what to do, since we deliberately did nothing.
    expect(action.kind !== 'replace' && action.message).toMatch(/kill 4242/);
  });

  it('never claims a non-daemon process, even one run from a claudescope checkout', () => {
    // The invariant that matters. This very vitest process runs under node from a
    // directory called `claudescope`, so a `claudescope`-only match claimed it —
    // which is why the probe also requires the server bundle's filename.
    expect(daemon.daemonOwnsPid(process.pid)).not.toBe(true);
  });

  it('daemonOwnsPid returns unknown for a PID that cannot be inspected', () => {
    // 2^22 is above every platform's default pid_max, so the probe fails.
    expect(daemon.daemonOwnsPid(4_194_304)).toBe('unknown');
  });
});

describe('terminateDaemon ownership gate', () => {
  // Every SIGTERM of a recorded PID funnels through terminateDaemon, so the gate
  // has to live INSIDE it: `stop`/`restart`/`update` never see the verdict
  // themselves, and a PID recycled after a crash belongs to the user's own
  // unrelated process.
  const killSpy = () =>
    vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) throw new Error('ESRCH'); // waitForExit: already exited
      return true;
    });
  const sigterms = (kill: ReturnType<typeof killSpy>) =>
    kill.mock.calls.filter(([, signal]) => signal === 'SIGTERM');

  it('discards a recycled record without signalling the process', async () => {
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const kill = killSpy();
    const action = await daemon.terminateDaemon(record(), () => false);
    expect(action.kind).toBe('discard');
    expect(existsSync(DAEMON_FILE)).toBe(false);
    expect(sigterms(kill)).toEqual([]);
  });

  it('refuses, and keeps the record, when ownership cannot be determined', async () => {
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const kill = killSpy();
    const action = await daemon.terminateDaemon(record(), () => 'unknown');
    expect(action.kind).toBe('refuse');
    expect(action.kind !== 'replace' && action.message).toMatch(/kill 4242/);
    // The record survives: we could not prove it stale, so dropping it would
    // orphan a daemon that may well still be serving.
    expect(existsSync(DAEMON_FILE)).toBe(true);
    expect(sigterms(kill)).toEqual([]);
  });

  it('SIGTERMs once and clears the record when the PID is ours', async () => {
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const kill = killSpy();
    const action = await daemon.terminateDaemon(record(), () => true);
    expect(action.kind).toBe('replace');
    expect(sigterms(kill)).toEqual([[4242, 'SIGTERM']]);
    expect(existsSync(DAEMON_FILE)).toBe(false);
  });
});

describe('daemon.json is written by the process that holds the port', () => {
  it('records the given pid, port and this version', () => {
    daemon.writeDaemonRecord(4317, 999);
    expect(cli.readDaemon()).toMatchObject({
      pid: 999,
      port: 4317,
      url: 'http://localhost:4317',
      version: APP_VERSION,
    });
  });

  it.skipIf(process.platform === 'win32')('writes it owner-only', () => {
    daemon.writeDaemonRecord(4317, 999);
    expect(statSync(DAEMON_FILE).mode & 0o777).toBe(0o600);
  });

  it('spawnDaemon writes no record — a spawn that loses the port race must not', () => {
    // Two CLIs racing (Claude Code and Codex both starting `claudescope mcp`)
    // both spawn; the loser dies with EADDRINUSE, and its record used to
    // overwrite the winner's — leaving `stop` reporting "not running".
    vi.mocked(spawn).mockReturnValue({ pid: 12345, unref: () => {} } as unknown as ChildProcess);
    daemon.spawnDaemon(4317);
    expect(existsSync(DAEMON_FILE)).toBe(false);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
      env: expect.objectContaining({ CLAUDESCOPE_DAEMON: '1' }),
    });
  });
});

describe('ensureDaemon on a wedged record', () => {
  const base = (over: Partial<import('../src/daemon.js').DaemonProbes> = {}) => ({
    alive: () => true,
    owns: () => true as boolean | 'unknown',
    healthy: async () => false, // wedged: alive but not answering
    health: async () => null,
    terminate: terminateProbe(),
    spawn: vi.fn(),
    waitHealthy: async () => true,
    ...over,
  });

  it('SIGTERMs and respawns when the PID is ours', async () => {
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const p = base();
    await daemon.ensureDaemon(() => {}, p);
    expect(p.terminate).toHaveBeenCalledOnce();
    expect(p.spawn).toHaveBeenCalledOnce();
  });

  it('spawns WITHOUT signalling when the PID was recycled', async () => {
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const p = base({ owns: () => false });
    await daemon.ensureDaemon(() => {}, p);
    expect(p.terminate).not.toHaveBeenCalled();
    expect(p.spawn).toHaveBeenCalledOnce();
  });

  it('signals nothing and throws when ownership is unknown', async () => {
    writeFileSync(DAEMON_FILE, JSON.stringify(record()));
    const p = base({ owns: () => 'unknown' });
    await expect(daemon.ensureDaemon(() => {}, p)).rejects.toThrow(/could not verify/i);
    expect(p.terminate).not.toHaveBeenCalled();
    expect(p.spawn).not.toHaveBeenCalled();
  });
});

describe('parsePort', () => {
  it('defaults when the flag is absent', () => {
    expect(cli.parsePort(undefined, 4317)).toBe(4317);
  });

  it.each(['8080', '1', '65535'])('accepts %s', (v) => {
    expect(cli.parsePort(v, 4317)).toBe(Number(v));
  });

  // Each of these used to reach spawnDaemon: the daemon died instantly with
  // ERR_SOCKET_BAD_PORT (or bound a random port for 0) while the CLI polled the
  // recorded value for 20s. `0` is legal to listen on but unusable here, because
  // the OS picks the port and the recorded one can never answer.
  it.each(['abc', '0', '-1', '99999', '80.5', '', ' '])('rejects %s', (v) => {
    expect(() => cli.parsePort(v, 4317)).toThrow(/between 1 and 65535/);
  });
});
