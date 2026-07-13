/**
 * Unit tests for the post-update self-heal helpers in self-restart.ts: bin
 * resolution from PATH, installed-version probing via `<bin> version` (the
 * channel-agnostic detection that works for npm symlinks, brew Cellar, and nix
 * makeWrapper scripts alike), and the marker-based loop guard that keeps a
 * failed hand-off or an in-progress install from becoming a restart storm.
 *
 * CLAUDESCOPE_HOME is set before importing the module (config.ts reads env at
 * import time). No real daemon is ever spawned — only tiny fake bin scripts.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'claudescope-selfrestart-'));
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
process.env.CLAUDESCOPE_HOME = home;

const sr = await import('../src/self-restart.js');

afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A directory containing an (empty, executable) `claudescope` bin. */
function binDir(name: string, binName = 'claudescope'): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, binName), '#!/bin/sh\n');
  chmodSync(join(dir, binName), 0o755);
  return dir;
}

/** An executable fake `claudescope` whose body is the given shell script. */
function fakeBin(name: string, script: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'claudescope');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('resolveInstalledBin', () => {
  it('finds the bin on PATH', () => {
    const dir = binDir('path-hit');
    expect(sr.resolveInstalledBin(dir, 'linux')).toBe(join(dir, 'claudescope'));
  });

  it('returns null when no PATH entry has it', () => {
    const empty = join(work, 'path-empty');
    mkdirSync(empty, { recursive: true });
    expect(sr.resolveInstalledBin([empty, '/nonexistent'].join(delimiter), 'linux')).toBeNull();
  });

  it('picks the first match in PATH order (shadowing works as in a shell)', () => {
    const first = binDir('path-first');
    const second = binDir('path-second');
    expect(sr.resolveInstalledBin([first, second].join(delimiter), 'linux')).toBe(
      join(first, 'claudescope'),
    );
  });

  it('finds .cmd shims on win32 but ignores them elsewhere', () => {
    const dir = binDir('path-cmd', 'claudescope.cmd');
    expect(sr.resolveInstalledBin(dir, 'win32')).toBe(join(dir, 'claudescope.cmd'));
    expect(sr.resolveInstalledBin(dir, 'linux')).toBeNull();
  });
});

// Fake-bin shell scripts need a POSIX shell; the helpers themselves are
// platform-independent and covered by the matrix above on Windows.
describe.skipIf(process.platform === 'win32')('readInstalledVersion', () => {
  it('returns the version the bin prints', async () => {
    const bin = fakeBin('ver-ok', 'echo 0.12.0');
    expect(await sr.readInstalledVersion(bin)).toBe('0.12.0');
  });

  it('rejects output that is not x.y.z (an error banner, a wrapper failure)', async () => {
    const bin = fakeBin('ver-garbage', 'echo "command not found"');
    expect(await sr.readInstalledVersion(bin)).toBeNull();
  });

  it('rejects a dev build on PATH (npm link) — never a valid restart target', async () => {
    const bin = fakeBin('ver-dev', 'echo 0.0.0-dev');
    expect(await sr.readInstalledVersion(bin)).toBeNull();
  });

  it('returns null when the bin exits non-zero', async () => {
    const bin = fakeBin('ver-fail', 'exit 1');
    expect(await sr.readInstalledVersion(bin)).toBeNull();
  });

  it('times out a hung bin instead of blocking the daemon', async () => {
    const bin = fakeBin('ver-hang', 'sleep 30');
    expect(await sr.readInstalledVersion(bin, 250)).toBeNull();
  });

  it('returns null when the bin does not exist', async () => {
    expect(await sr.readInstalledVersion(join(work, 'no-such-bin'))).toBeNull();
  });
});

describe('shouldSelfRestart', () => {
  const now = Date.parse('2026-07-13T12:00:00.000Z');
  const marker = (target: string, ageMs: number) => ({
    target,
    at: new Date(now - ageMs).toISOString(),
  });

  it('restarts when versions differ and there is no marker', () => {
    expect(sr.shouldSelfRestart('0.12.0', '0.11.0', null, now)).toBe(true);
  });

  it('never restarts into the version already running', () => {
    expect(sr.shouldSelfRestart('0.11.0', '0.11.0', null, now)).toBe(false);
  });

  it('suppresses a retry for the same target within the window', () => {
    expect(sr.shouldSelfRestart('0.12.0', '0.11.0', marker('0.12.0', 5 * 60 * 1000), now)).toBe(
      false,
    );
  });

  it('retries the same target once the window has passed', () => {
    expect(sr.shouldSelfRestart('0.12.0', '0.11.0', marker('0.12.0', 2 * 60 * 60 * 1000), now)).toBe(
      true,
    );
  });

  it('a marker for a different target does not block (new upgrade resets the guard)', () => {
    expect(sr.shouldSelfRestart('0.13.0', '0.11.0', marker('0.12.0', 5 * 60 * 1000), now)).toBe(
      true,
    );
  });

  it('rejects installed strings that are not versions', () => {
    expect(sr.shouldSelfRestart('', '0.11.0', null, now)).toBe(false);
    expect(sr.shouldSelfRestart('link', '0.11.0', null, now)).toBe(false);
  });

  it('a corrupt marker timestamp does not wedge the guard shut', () => {
    expect(
      sr.shouldSelfRestart('0.12.0', '0.11.0', { target: '0.12.0', at: 'not-a-date' }, now),
    ).toBe(true);
  });
});
