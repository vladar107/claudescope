/**
 * `claudescope hook session-start` — the plugin's SessionStart hook.
 *
 * Both harnesses run it with their SessionStart JSON on stdin and a 5 s budget.
 * The plugin's hooks.json matches only `compact`, and the hook answers from the
 * payload alone: one line saying the pre-compaction transcript is still
 * readable locally, with the command to read its end. It never touches the
 * daemon (`ensureDaemon()` spawns and then waits up to 30 s), git, or the
 * network, never writes to stderr, never fails, and prints either nothing or
 * the one JSON line the harness injects as context.
 *
 * Earlier sessions are deliberately not injected at startup/resume/clear: that
 * puts untrusted session titles into every session's context whether or not
 * the work continues anything, and `clear` is the user asking for a fresh
 * context. The history skill covers those moments on demand.
 */

/** Cap on the stdin we read — the harness payload is a few hundred bytes. */
const MAX_STDIN_BYTES = 1024 * 1024;
/** Session ids are interpolated into a shell command in the injected text, so
 *  only the conservative shape every connector produces is accepted. */
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * The id of the session that was just compacted, or null for anything else:
 * an unparsable payload, another trigger (the matcher is `compact`, but a
 * broader one copied into a user's own settings must still get silence), or an
 * id that is not safe on a command line. Both harnesses name the trigger
 * `source`.
 */
function compactedSessionId(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { session_id: sessionId, source } = parsed as Record<string, unknown>;
  if (source !== 'compact') return null;
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId) ? sessionId : null;
}

/** The one JSON line the harnesses read as context injection. */
function hookLine(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  });
}

/** A pointer, never transcript text — re-injecting the transcript right after
 *  a compaction would defeat the compaction. */
function compactContext(sessionId: string): string {
  return (
    "ClaudeScope: this session's context was compacted; the full pre-compaction " +
    `transcript stays indexed locally. Read its end with: claudescope session ${sessionId} --tail 20 --redact`
  );
}

/** Explicit opt-out: the plugin's hook is on by default in both harnesses. */
function disabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.CLAUDESCOPE_HOOKS?.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off';
}

/** The hook's whole decision as a pure function of stdin and the environment:
 *  the JSON line to print, or null for "say nothing". */
export function runSessionStartHook(
  rawStdin: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (disabled(env)) return null;
  const sessionId = compactedSessionId(rawStdin);
  return sessionId === null ? null : hookLine(compactContext(sessionId));
}

/** Read stdin to EOF, bounded — the hook must not buffer an unexpected flood. */
async function readStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer;
    chunks.push(buf);
    total += buf.length;
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/**
 * CLI entry: read the harness payload, print the context line if there is one,
 * and swallow everything else. It must never write to stderr or set a non-zero
 * exit code — a noisy or failing hook shows up after every compaction.
 */
export async function sessionStartHookMain(): Promise<void> {
  try {
    // No harness payload on a terminal; without this it would block on stdin.
    if (process.stdin.isTTY) return;
    const line = runSessionStartHook(await readStdin(MAX_STDIN_BYTES));
    if (line) process.stdout.write(`${line}\n`);
  } catch (err) {
    if (process.env.CLAUDESCOPE_HOOK_DEBUG) {
      process.stderr.write(`claudescope hook: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
