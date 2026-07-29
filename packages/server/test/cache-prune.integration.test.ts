/**
 * Normalize-cache pruning.
 *
 * Connectors that can't be projected per-row write the normalized session to
 * `~/.claudescope/cache/<agent>/<hash>.ndjson` — the transcript **verbatim**,
 * including whatever secrets appeared in it. Nothing removed those files: not the
 * indexer's removed-file prune (DB rows only), not "Rebuild index" (which discards
 * `index.duckdb*`), and no CLI command. So deleting a session from `~/.codex` left
 * Claudescope's plaintext copy on disk indefinitely, and the directory only grew.
 *
 * The interesting edge is the interaction with connector isolation: a connector
 * whose `discover()` throws has its indexed sessions deliberately preserved
 * (the absence is transient), so its cache must be preserved too — otherwise a
 * flaky source would delete the cache it is about to need again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- temp locations (decided before any server module is imported) ----------
const work = mkdtempSync(join(tmpdir(), 'claudescope-cacheprune-'));
const home = join(work, 'home');
const codexDir = join(work, 'codex');

process.env.CLAUDE_PROJECTS_DIR = join(work, 'claude-empty');
process.env.CODEX_SESSIONS_DIR = codexDir;
for (const v of [
  'JUNIE_SESSIONS_DIR',
  'PI_SESSIONS_DIR',
  'OPENCODE_DATA_DIR',
  'COPILOT_SESSIONS_DIR',
  'ANTIGRAVITY_CLI_DIR',
  'ANTIGRAVITY_DIR',
  'GROK_SESSIONS_DIR',
]) {
  process.env[v] = join(work, `${v.toLowerCase()}-empty`);
}
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = home;
process.env.REINDEX_INTERVAL_MS = '0';

const SECRET = 'sk-cache-prune-must-not-outlive-the-source-9f2b';
const ts = (s: number) => new Date(Date.UTC(2026, 2, 1, 10, 0, s)).toISOString();
const codexCache = join(home, 'cache', 'codex');

/** A minimal but real Codex rollout, so the normalizer actually produces rows. */
function writeRollout(name: string, sessionId: string, secret: string): string {
  const dir = join(codexDir, '2026', '03', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-03-01T10-00-00-${name}.jsonl`);
  writeFileSync(
    file,
    [
      { type: 'session_meta', timestamp: ts(0), payload: { id: sessionId, cwd: '/tmp/cacheproj', cli_version: '0.122.0', model_provider: 'openai', git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(1), payload: { model: 'gpt-5.4', cwd: '/tmp/cacheproj' } },
      { type: 'response_item', timestamp: ts(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: secret }] } },
      { type: 'response_item', timestamp: ts(3), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'noted' }] } },
      { type: 'event_msg', timestamp: ts(4), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 50 } }, rate_limits: {} } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  return file;
}

const cacheFiles = (): string[] => {
  try {
    return readdirSync(codexCache).filter((f) => f.endsWith('.ndjson')).sort();
  } catch {
    return [];
  }
};

/** Does any cache file still contain the transcript's secret? */
const secretOnDisk = (): boolean =>
  cacheFiles().some((f) => readFileSync(join(codexCache, f), 'utf8').includes(SECRET));

let reindex: () => Promise<import('@claudescope/shared').ReindexResponse>;
let closeConnection: () => Promise<void>;
let fileA: string;
let fileB: string;

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  fileA = writeRollout('aaaaaaaa-0000-4000-8000-00000000000a', 'codex-cache-a', SECRET);
  fileB = writeRollout('bbbbbbbb-0000-4000-8000-00000000000b', 'codex-cache-b', 'nothing secret here');

  ({ reindex } = await import('../src/data/index.js'));
  ({ closeConnection } = await import('../src/db/duckdb.js'));
  await reindex();
});

afterAll(async () => {
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

describe('a deleted session leaves no plaintext copy behind', () => {
  it('caches both sessions while they exist', () => {
    expect(cacheFiles()).toHaveLength(2);
    // The whole reason this matters: the cache holds the transcript verbatim.
    expect(secretOnDisk()).toBe(true);
  });

  it('prunes the cache entry when its source file is deleted', async () => {
    rmSync(fileA);
    await reindex();

    expect(cacheFiles()).toHaveLength(1);
    expect(secretOnDisk()).toBe(false);
    // The surviving session is untouched — pruning is per-file, not a wipe.
    expect(readFileSync(join(codexCache, cacheFiles()[0]!), 'utf8')).toContain('codex-cache-b');
  });

  it('sweeps an orphan that no connector ever claimed', async () => {
    // Simulates a file left by an older version, or a crash between prepare()
    // and the load. The name is not any live source's hash, so it must go.
    const orphan = join(codexCache, 'deadbeefdeadbeef.ndjson');
    writeFileSync(orphan, `{"session_id":"gone","text_content":"${SECRET}"}\n`);
    expect(existsSync(orphan)).toBe(true);

    await reindex();
    expect(existsSync(orphan)).toBe(false);
    expect(secretOnDisk()).toBe(false);
  });

  it('keeps the entry for a source that still exists', async () => {
    // Guards the obvious catastrophic failure: an over-eager sweep deleting the
    // cache of every unchanged file (only CHANGED files are re-prepared, so a
    // wrongly-pruned entry would leave the projection reading a missing file).
    const before = cacheFiles();
    await reindex();
    await reindex();
    expect(cacheFiles()).toEqual(before);
    expect(existsSync(fileB)).toBe(true);
  });
});

describe('a connector whose discovery fails keeps its cache', () => {
  it('does not prune when discover() throws', async () => {
    const { connectors } = await import('../src/connectors/registry.js');
    const codex = connectors.find((c) => c.id === 'codex')!;
    const realDiscover = codex.discover;
    const before = cacheFiles();
    expect(before).toHaveLength(1);

    // Same isolation the indexer applies to indexed sessions: a throwing
    // connector's absence is transient, so its cache must survive.
    codex.discover = () => {
      throw new Error('transient source failure');
    };
    try {
      await reindex();
      expect(cacheFiles()).toEqual(before);
    } finally {
      codex.discover = realDiscover;
    }

    // And it recovers once discovery works again.
    await reindex();
    expect(cacheFiles()).toEqual(before);
  });
});
