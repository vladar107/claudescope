/**
 * Unit tests for the SessionStart hook (`claudescope hook session-start`).
 *
 * The hook runs after every compaction under a 5 s harness budget, and what it
 * prints is a command line the agent is told to run, so the edges that matter
 * are the ones that would make it noisy or unsafe: triggers it must stay quiet
 * on even when a matcher lets them through, the opt-out, and session ids that
 * are not safe on a command line.
 */

import { describe, expect, it } from 'vitest';
import { runSessionStartHook } from '../src/agent/hook.js';

const CURRENT = 'sess-current';

const stdin = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: CURRENT,
    cwd: '/tmp/hookproj',
    source: 'compact',
    ...over,
  });

/** The injected text out of the hook's JSON line. */
function context(line: string | null): string {
  expect(line).not.toBeNull();
  const parsed = JSON.parse(line as string) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
  return parsed.hookSpecificOutput.additionalContext;
}

describe('compaction', () => {
  it('emits the recovery pointer in the harness JSON form', () => {
    const text = context(runSessionStartHook(stdin(), {}));
    expect(text).toContain(`claudescope session ${CURRENT} --tail 20 --redact`);
  });

  it.each(['startup', 'resume', 'clear'])(
    'stays quiet on source=%s even when a broader matcher lets it through',
    (source) => {
      expect(runSessionStartHook(stdin({ source }), {})).toBeNull();
    },
  );
});

describe('opt-out and unusable input', () => {
  it.each(['0', 'false', 'off'])('is disabled by CLAUDESCOPE_HOOKS=%s', (value) => {
    expect(runSessionStartHook(stdin(), { CLAUDESCOPE_HOOKS: value })).toBeNull();
  });

  it('rejects a session id that is not safe on a command line', () => {
    expect(runSessionStartHook(stdin({ session_id: 'sess\n; echo pwned' }), {})).toBeNull();
  });

  it.each([
    ['not JSON at all', 'not json {'],
    ['a JSON scalar', '"compact"'],
    ['no session_id', JSON.stringify({ source: 'compact' })],
    ['no source', JSON.stringify({ session_id: CURRENT })],
    ['empty stdin', ''],
  ])('stays quiet on %s', (_name, raw) => {
    expect(runSessionStartHook(raw, {})).toBeNull();
  });
});
