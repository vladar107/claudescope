/**
 * Unit tests for the settings.json layer (settings.ts): per-call env > file >
 * default precedence, the mtime-cached file read, corruption handling (defaults
 * + warn-once + .bak on save), null-clears / unknown-key preservation in
 * saveSettings, the derived opencodeDbPath default, and validateSettingsPatch.
 *
 * CLAUDESCOPE_HOME is pointed at a temp dir BEFORE the module import (SETTINGS_PATH
 * is computed at import time), and every setting's env var is deleted per test —
 * the getters read env PER CALL, so an inherited var would silently win over the
 * file layer under test.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// --- temp home (decided before the settings module is imported) -------------
const work = mkdtempSync(join(tmpdir(), 'claudescope-settings-unit-'));
const home = join(work, 'home');
process.env.CLAUDESCOPE_HOME = home;
mkdirSync(home, { recursive: true });

const {
  SETTINGS_PATH,
  SETTINGS_SCHEMA_VERSION,
  SETTING_DEFS,
  fileValueOf,
  grokSessionsDir,
  opencodeDataDir,
  openBrowserOnStart,
  reindexIntervalMs,
  resetSettingsCache,
  resolveSetting,
  saveSettings,
  validateSettingsPatch,
} = await import('../src/settings.js');

/**
 * Force a strictly-increasing mtime so the mtime-keyed cache busts even when
 * two rewrites land in the same millisecond (same idiom as pricing.test.ts).
 */
let mtimeTick = Math.floor(Date.now() / 1000);
const bumpMtime = (path: string): void => {
  mtimeTick += 2;
  utimesSync(path, mtimeTick, mtimeTick);
};

/** Write settings.json directly (bypassing saveSettings) with a fresh mtime. */
const writeSettings = (data: Record<string, unknown>): void => {
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(data, null, 2)}\n`);
  bumpMtime(SETTINGS_PATH);
};

const readSettingsRaw = (): string => readFileSync(SETTINGS_PATH, 'utf8');

beforeEach(() => {
  // The resolvers read env per call: strip every setting's env var so nothing
  // inherited from the parent shell/vitest can shadow the layer under test.
  for (const def of SETTING_DEFS) {
    if (def.envVar) delete process.env[def.envVar];
  }
  delete process.env.OPEN_BROWSER;
  rmSync(SETTINGS_PATH, { force: true });
  rmSync(`${SETTINGS_PATH}.bak`, { force: true });
  resetSettingsCache();
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('resolveSetting precedence (env > file > default, per call)', () => {
  it('path key: env wins over file, file over default, with ~ expanded on both layers', () => {
    writeSettings({ grokSessionsDir: '~/file-grok' });
    process.env.GROK_SESSIONS_DIR = '~/env-grok';

    expect(resolveSetting('grokSessionsDir')).toEqual({
      value: join(homedir(), 'env-grok'),
      source: 'env',
    });
    expect(grokSessionsDir()).toBe(join(homedir(), 'env-grok'));

    // Same process, same call site: dropping the env var flips to the file layer.
    delete process.env.GROK_SESSIONS_DIR;
    expect(resolveSetting('grokSessionsDir')).toEqual({
      value: join(homedir(), 'file-grok'),
      source: 'file',
    });
    // fileValueOf returns the RAW saved value (unexpanded, for display).
    expect(fileValueOf('grokSessionsDir')).toBe('~/file-grok');

    // Clearing the file value reverts to the default.
    saveSettings({ grokSessionsDir: null });
    expect(resolveSetting('grokSessionsDir')).toEqual({
      value: join(homedir(), '.grok', 'sessions'),
      source: 'default',
    });
  });

  it('number key: a "0" env value resolves to 0 and still beats a file value', () => {
    writeSettings({ reindexIntervalMs: 5000 });
    process.env.REINDEX_INTERVAL_MS = '0';
    expect(resolveSetting('reindexIntervalMs')).toEqual({ value: 0, source: 'env' });
    expect(reindexIntervalMs()).toBe(0);
  });

  it('number key: an unparsable env value falls through to file, then default', () => {
    process.env.REINDEX_INTERVAL_MS = 'abc';
    writeSettings({ reindexIntervalMs: 5000 });
    expect(resolveSetting('reindexIntervalMs')).toEqual({ value: 5000, source: 'file' });

    saveSettings({ reindexIntervalMs: null });
    expect(resolveSetting('reindexIntervalMs')).toEqual({ value: 15000, source: 'default' });
  });

  it('a wrong-typed file value is ignored (falls through to default)', () => {
    writeSettings({ reindexIntervalMs: 'not-a-number', grokSessionsDir: 42 });
    expect(fileValueOf('reindexIntervalMs')).toBeUndefined();
    expect(resolveSetting('reindexIntervalMs')).toEqual({ value: 15000, source: 'default' });
    expect(resolveSetting('grokSessionsDir').source).toBe('default');
  });

  it('openBrowser has NO env layer: OPEN_BROWSER never overrides file/default', () => {
    // OPEN_BROWSER is the internal launcher contract, always pinned by the
    // daemon spawner — reading it would misreport user intent.
    process.env.OPEN_BROWSER = '1';
    writeSettings({ openBrowser: false });
    expect(openBrowserOnStart()).toBe(false);
    expect(resolveSetting('openBrowser').source).toBe('file');

    saveSettings({ openBrowser: null });
    process.env.OPEN_BROWSER = '0';
    expect(openBrowserOnStart()).toBe(true); // default, not the env var
    expect(resolveSetting('openBrowser').source).toBe('default');
  });
});

describe('corrupt settings.json', () => {
  it('falls back to defaults, leaves the file untouched, and warns once (not per call)', () => {
    writeFileSync(SETTINGS_PATH, '{ this is not json');
    bumpMtime(SETTINGS_PATH);
    const before = readSettingsRaw();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSetting('grokSessionsDir')).toEqual({
      value: join(homedir(), '.grok', 'sessions'),
      source: 'default',
    });
    expect(resolveSetting('reindexIntervalMs')).toEqual({ value: 15000, source: 'default' });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    // The read path never rewrites the user's file.
    expect(readSettingsRaw()).toBe(before);
  });

  it('saveSettings backs a corrupt file up to .bak before overwriting it', () => {
    writeFileSync(SETTINGS_PATH, '{ this is not json');
    bumpMtime(SETTINGS_PATH);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    saveSettings({ grokSessionsDir: '/abs/grok' });
    warn.mockRestore();

    // The corrupt bytes survive in the backup; the new file is valid JSON.
    expect(readFileSync(`${SETTINGS_PATH}.bak`, 'utf8')).toBe('{ this is not json');
    expect(JSON.parse(readSettingsRaw())).toEqual({
      grokSessionsDir: '/abs/grok',
      schemaVersion: SETTINGS_SCHEMA_VERSION,
    });
    expect(resolveSetting('grokSessionsDir')).toEqual({ value: '/abs/grok', source: 'file' });
  });
});

describe('saveSettings', () => {
  it('null clears a key, unknown file keys survive saves, schemaVersion is stamped', () => {
    writeSettings({ grokSessionsDir: '/abs/a', futureKnob: 'kept' });

    saveSettings({ grokSessionsDir: '/abs/b' });
    let onDisk = JSON.parse(readSettingsRaw()) as Record<string, unknown>;
    expect(onDisk.grokSessionsDir).toBe('/abs/b');
    expect(onDisk.futureKnob).toBe('kept'); // forward compatibility
    expect(onDisk.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);

    saveSettings({ grokSessionsDir: null });
    onDisk = JSON.parse(readSettingsRaw()) as Record<string, unknown>;
    expect('grokSessionsDir' in onDisk).toBe(false);
    expect(onDisk.futureKnob).toBe('kept');
    expect(resolveSetting('grokSessionsDir').source).toBe('default');
  });

  it('opencodeDbPath default re-derives live from a saved opencodeDataDir', () => {
    const dataDir = join(work, 'oc-data');
    saveSettings({ opencodeDataDir: dataDir });
    expect(opencodeDataDir()).toBe(dataDir);
    // Still source 'default' — the DB path itself was never saved, its default
    // just tracks the EFFECTIVE data dir.
    expect(resolveSetting('opencodeDbPath')).toEqual({
      value: join(dataDir, 'opencode.db'),
      source: 'default',
    });
  });
});

describe('mtime-cached file read', () => {
  it('picks up a hand-rewritten file on the next call once its mtime changes', () => {
    writeSettings({ grokSessionsDir: '/abs/first' });
    expect(grokSessionsDir()).toBe('/abs/first'); // warm the cache

    // Rewrite behind the module's back — no saveSettings, no resetSettingsCache.
    writeFileSync(SETTINGS_PATH, JSON.stringify({ grokSessionsDir: '/abs/second' }));
    bumpMtime(SETTINGS_PATH); // guarantee a distinct mtime without sleeping
    expect(grokSessionsDir()).toBe('/abs/second');
  });
});

describe('validateSettingsPatch', () => {
  it('rejects unknown keys', () => {
    const v = validateSettingsPatch({ bogusKey: '/x' });
    expect(v.errors).toEqual({ bogusKey: 'unknown setting' });
  });

  it('rejects relative, empty, and non-string paths', () => {
    expect(validateSettingsPatch({ grokSessionsDir: 'rel/path' }).errors.grokSessionsDir).toMatch(
      /absolute/,
    );
    expect(validateSettingsPatch({ grokSessionsDir: '   ' }).errors.grokSessionsDir).toMatch(
      /non-empty/,
    );
    expect(validateSettingsPatch({ grokSessionsDir: 42 }).errors.grokSessionsDir).toMatch(
      /non-empty/,
    );
  });

  it('interval: 500 rejected, 0 and 1000 accepted, non-integers rejected', () => {
    expect(validateSettingsPatch({ reindexIntervalMs: 500 }).errors.reindexIntervalMs).toMatch(
      /1000/,
    );
    expect(validateSettingsPatch({ reindexIntervalMs: 0 }).errors).toEqual({});
    expect(validateSettingsPatch({ reindexIntervalMs: 1000 }).errors).toEqual({});
    expect(validateSettingsPatch({ reindexIntervalMs: 1500.5 }).errors.reindexIntervalMs).toMatch(
      /integer/,
    );
    expect(validateSettingsPatch({ reindexIntervalMs: '5000' }).errors.reindexIntervalMs).toMatch(
      /integer/,
    );
  });

  it('rejects a boolean type mismatch', () => {
    expect(validateSettingsPatch({ openBrowser: 'yes' }).errors.openBrowser).toMatch(
      /true or false/,
    );
  });

  it('a nonexistent dir (or a file where a dir is expected) warns, never errors', () => {
    const missing = validateSettingsPatch({ grokSessionsDir: join(work, 'not-there') });
    expect(missing.errors).toEqual({});
    expect(missing.warnings).toEqual([
      { key: 'grokSessionsDir', message: expect.stringContaining('does not exist') },
    ]);

    const filePath = join(work, 'plain-file');
    writeFileSync(filePath, 'x');
    const notDir = validateSettingsPatch({ grokSessionsDir: filePath });
    expect(notDir.errors).toEqual({});
    expect(notDir.warnings).toEqual([
      { key: 'grokSessionsDir', message: expect.stringContaining('not a directory') },
    ]);
  });

  it('warns when an env var currently shadows the saved key', () => {
    process.env.CODEX_SESSIONS_DIR = '/somewhere-else';
    const v = validateSettingsPatch({ codexSessionsDir: work }); // exists, is a dir
    expect(v.errors).toEqual({});
    expect(v.warnings).toContainEqual({
      key: 'codexSessionsDir',
      message: expect.stringContaining('$CODEX_SESSIONS_DIR'),
    });
  });

  it('null clears are always valid', () => {
    const v = validateSettingsPatch({ grokSessionsDir: null, reindexIntervalMs: null });
    expect(v.errors).toEqual({});
    expect(v.warnings).toEqual([]);
  });
});

describe('read path never creates state', () => {
  it('resolving with no settings.json neither throws nor writes one', () => {
    expect(resolveSetting('claudeProjectsDir').source).toBe('default');
    expect(existsSync(SETTINGS_PATH)).toBe(false);
  });
});
