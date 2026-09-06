/**
 * Fitness function: one sessions-dir walk per indexer pass.
 *
 * `discover()` walks the Codex sessions dir once at the start of a pass;
 * `getCodexContext()` (used to resolve a subagent's root thread while
 * preparing it) must reuse that same walk instead of re-`readdirSync`-ing for
 * every subagent rollout it prepares. See `listRollouts`/`getCodexContext` in
 * `connectors/codex/normalize.ts`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRow } from '../src/connectors/canonical.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

const work = mkdtempSync(join(tmpdir(), 'claudescope-codex-walk-'));
const codexDir = join(work, 'codex');

// Isolate every other source dir so this suite touches nothing but its own
// fixtures, and set CLAUDESCOPE_HOME before any server module is imported.
process.env.CLAUDE_PROJECTS_DIR = join(work, 'claude-empty');
process.env.CODEX_SESSIONS_DIR = codexDir;
process.env.JUNIE_SESSIONS_DIR = join(work, 'junie-empty');
process.env.PI_SESSIONS_DIR = join(work, 'pi-empty');
process.env.OPENCODE_DATA_DIR = join(work, 'opencode-empty');
process.env.COPILOT_SESSIONS_DIR = join(work, 'copilot-empty');
process.env.ANTIGRAVITY_CLI_DIR = join(work, 'antigravity-empty');
process.env.ANTIGRAVITY_DIR = join(work, 'antigravity-empty-desktop');
process.env.GROK_SESSIONS_DIR = join(work, 'grok-empty');
process.env.CLAUDESCOPE_HOME = join(work, 'home');

const jsonl = (events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const ts = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;

const rootId = 'codex-sess-root';
const childId = '019f2222-aaaa-7bbb-8ccc-000000000001';
const grandchildId = '019f2222-aaaa-7bbb-8ccc-000000000002';
const lateChildId = '019f2222-aaaa-7bbb-8ccc-000000000003';

const rolloutsDir = join(codexDir, '2026', '01', '01');

/** A root rollout: no `thread_source`, so it stays a top-level session. */
function writeRootRollout(): string {
  mkdirSync(rolloutsDir, { recursive: true });
  const file = join(rolloutsDir, `rollout-2026-01-01T10-00-00-${rootId}.jsonl`);
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(0), payload: { id: rootId, cwd: '/tmp/codexproj', git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(1), payload: { model: 'gpt-5.4', cwd: '/tmp/codexproj' } },
      { type: 'response_item', timestamp: ts(2), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'walk once please' }] } },
      { type: 'response_item', timestamp: ts(3), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'on it' }] } },
    ]),
  );
  return file;
}

/** A depth-1 subagent rollout, parented directly under the root. */
function writeChildRollout(): string {
  mkdirSync(rolloutsDir, { recursive: true });
  const file = join(rolloutsDir, `rollout-2026-01-01T10-01-00-${childId}.jsonl`);
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(10), payload: { id: childId, cwd: '/tmp/codexproj', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_nickname: 'Linnaeus', agent_role: 'explorer' } } }, git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(11), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(12), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'scan the repo' }] } },
      { type: 'response_item', timestamp: ts(13), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'scanning' }] } },
    ]),
  );
  return file;
}

/** A depth-2 subagent rollout: `parent_thread_id` names the depth-1 child. */
function writeGrandchildRollout(): string {
  mkdirSync(rolloutsDir, { recursive: true });
  const file = join(rolloutsDir, `rollout-2026-01-01T10-02-00-${grandchildId}.jsonl`);
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(20), payload: { id: grandchildId, cwd: '/tmp/codexproj', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: childId, depth: 2, agent_nickname: 'Chronicler', agent_role: 'summarizer' } } }, git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(21), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(22), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summarize findings' }] } },
      { type: 'response_item', timestamp: ts(23), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'summary done' }] } },
    ]),
  );
  return file;
}

/** A depth-1 rollout written AFTER the initial walk, to probe staleness. */
function writeLateChildRollout(): string {
  mkdirSync(rolloutsDir, { recursive: true });
  const file = join(rolloutsDir, `rollout-2026-01-01T10-03-00-${lateChildId}.jsonl`);
  writeFileSync(
    file,
    jsonl([
      { type: 'session_meta', timestamp: ts(30), payload: { id: lateChildId, cwd: '/tmp/codexproj', thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_nickname: 'Latecomer', agent_role: 'explorer' } } }, git: { branch: 'main' } } },
      { type: 'turn_context', timestamp: ts(31), payload: { model: 'gpt-5.4' } },
      { type: 'response_item', timestamp: ts(32), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'joined late' }] } },
      { type: 'response_item', timestamp: ts(33), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'noted' }] } },
    ]),
  );
  return file;
}

let codexConnector: typeof import('../src/connectors/codex/codex.js')['codexConnector'];
let getCodexContext: typeof import('../src/connectors/codex/normalize.js')['getCodexContext'];
let ndjsonCache: typeof import('../src/connectors/ndjson-cache.js')['ndjsonCache'];
let childPath: string;
let grandchildPath: string;

beforeAll(async () => {
  writeRootRollout();
  childPath = writeChildRollout();
  grandchildPath = writeGrandchildRollout();
  ({ codexConnector } = await import('../src/connectors/codex/codex.js'));
  ({ getCodexContext } = await import('../src/connectors/codex/normalize.js'));
  ({ ndjsonCache } = await import('../src/connectors/ndjson-cache.js'));
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('codex walk reuse', () => {
  it('reuses discover()\'s walk instead of re-walking per subagent prepare', async () => {
    const discovered = codexConnector.discover();
    expect(discovered.length).toBe(3);

    vi.mocked(readdirSync).mockClear();
    await codexConnector.prepare(childPath);
    await codexConnector.prepare(grandchildPath);

    const underSessionsDir = vi
      .mocked(readdirSync)
      .mock.calls.filter((call) => String(call[0]).startsWith(codexDir));
    expect(underSessionsDir).toHaveLength(0);
  });

  it('still resolves a multi-level subagent to its root after reuse', () => {
    const cache = ndjsonCache('codex');
    const raw = readFileSync(cache.path(grandchildPath), 'utf8');
    const rows: CanonicalRow[] = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as CanonicalRow);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.session_id).toBe(rootId);
      expect(row.is_sidechain).toBe(true);
    }
  });

  it('resolves a rollout added after the last discover(), and picks it up on the next one', async () => {
    const latePath = writeLateChildRollout();

    // No discover() call in between: getCodexContext() must still be usable —
    // a direct child of an already-known root resolves without needing the
    // memo to include the new file at all.
    await codexConnector.prepare(latePath);
    const cache = ndjsonCache('codex');
    const raw = readFileSync(cache.path(latePath), 'utf8');
    const rows: CanonicalRow[] = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as CanonicalRow);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.session_id).toBe(rootId);

    // The next discover() re-walks and refreshes the memo with the new file.
    codexConnector.discover();
    expect(getCodexContext().parents.get(lateChildId)).toBe(rootId);
  });
});
