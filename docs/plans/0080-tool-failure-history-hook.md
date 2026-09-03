# 0080 — Tool-failure history hook

- **Status:** abandoned
- **Date:** 2026-09-03
- **PR:** https://github.com/vladar107/claudescope/pull/103

## Outcome

Abandoned before implementation, by the same reasoning that narrowed plan
0078's hook to `compact`: history lookups should happen on the user's request
or the model's own judgment, not be forced on every failure. The measurement
below supports that — most failures that recur across sessions are harness
text, so the hook would have fired far more often than it helped. The
on-demand path is the history skill's `search --literal` recipe, which now
says which line of a failure to search for. The research is kept here for the
day a push mechanism is reconsidered; the design below is what it would look
like.

## Context

The third finding of issue
[#100](https://github.com/vladar107/claudescope/issues/100): the same tool
error was re-diagnosed from scratch in three separate sessions, because nothing
tells the agent it has seen the error before. Plan 0078 covered the compaction
moment with a hook and left startup on demand; plan 0079 added the two pieces
this needs — failed tool-result bodies in the index (`tool_error_text`) and
`search --literal` over them.

What the harnesses offer, verified against current docs and source:

- **Claude Code** has `PostToolUseFailure`: matcher on `tool_name`, payload with
  `session_id`, `cwd`, `tool_name`, `tool_use_id` and the error text in
  `error`; `hookSpecificOutput.additionalContext` is honoured, plain stdout is
  ignored for this event. Exit 1 from `grep`/`rg`/`find`/`diff`/`test`/
  `git diff` is benign and does not fire. Failures inside a subagent fire the
  parent's hooks too (with `agent_id`).
- **Codex** has no failure event. `PostToolUse` fires for a non-zero Bash exit
  but its payload carries no exit code or error flag, and an MCP `is_error`
  result does not fire it at all. Its plugin loader ignores an unknown event
  key under `hooks` at today's HEAD (`HookEventsToml` has no
  `deny_unknown_fields`), and the manifest's `hooks` field can name a
  different file (`"hooks": "./hooks/x.json"` replaces the default).

Measured on local transcripts (38 sessions, read-only): 59 failed tool results
in 12 sessions, median 4 per failing session, 32 of them `Bash`. A failure's
text is `Exit code N` followed by mixed stdout/stderr, with the real error near
the end (stack-trace last line, `error: pathspec …`, `command not found`); Node
appends a `Node.js vX` footer after it. Of 57 keyed failures, 20 recur in
another session — but most recurring ones are harness text (user rejections,
auto-mode denials, a PreToolUse guard), which history cannot help with.

## Goal

When a `Bash` or MCP tool call fails in Claude Code and the same error text
was hit in an earlier session of this project, the agent gets one line naming
where, with the command to read that spot. No snippets, no titles, nothing
when there is no match, nothing at all in Codex.

## Decisions

- **Claude Code only, with a separate Codex hooks file** — the Codex plugin
  manifest gains `"hooks": "./hooks/codex.json"` carrying only the SessionStart
  entry, so Codex never parses `PostToolUseFailure`; `hooks/hooks.json` stays
  the Claude Code default file with both events. Relying on Codex dropping
  unknown keys was rejected: it is verified only by source reading at one
  commit, and a stricter parser later would reject the whole file, SessionStart
  included. A test asserts the two files' SessionStart entries are identical.
- **Matcher `Bash|mcp__`** — the failures history helps with are commands and
  external tools. `Edit`/`Write` failures are mechanical ("String to replace not
  found"), `ExitPlanMode`/`AskUserQuestion` failures are user rejections; the
  matcher keeps them out before a process starts.
- **One key line, chosen from the end** — scan the error text backwards for
  the first line matching an error shape (`error`, `exception`, `fail`,
  `not found`, `cannot`, `unable`, `denied`, `refused`, `Traceback`, `ENOENT`
  and other `E[A-Z]{4,}` codes, `TS\d{4}`), skipping `Exit code N` /
  `Command failed …` wrappers and stripping `stderr:`/`stdout:` labels; fall
  back to the last non-empty line; trim; cap 200 code points; require at least
  16. Harness text (`The user doesn't want to proceed…`, `Permission for this
  action was denied…`, `PreToolUse:… hook error`, `<tool_use_error>Blocked`,
  `Command did not complete within…`, interrupts) means silence. Searching the
  whole error body was rejected: paths, PIDs and stdout make it unique.
- **Query only an existing daemon, never provision** — read `daemon.json`;
  no record or a dead pid means silence; otherwise one literal search request
  with a 2 s timeout, scoped to the project of `cwd`. No health probe (the
  request is the probe) and no `spawnDaemon()`: a failing tool call is not the
  moment to start services, and the compaction hook set the same rule.
- **Pointers only** — hits from other sessions, one per session, newest first,
  at most three, each as
  `claudescope session <id> --around <uuid> --radius 4 --max-tool-chars 1200 --redact`.
  Titles and snippets are untrusted transcript text and stay out; ids and
  uuids are validated before they reach a command line. Project scope was
  chosen over a global search: "did I hit this here before" is the question,
  and generic errors (`no matches found: …`) in unrelated projects would only
  add noise.
- **Once per error per session** — a retry loop must not re-inject the same
  pointer. `~/.claudescope/hooks/<session_id>.json` records the keys already
  reported; written owner-only via `ensureStateDir`, only on the injecting
  path, files older than 30 days pruned on write.
- **Same guard rails as the compaction hook** — `CLAUDESCOPE_HOOKS=0` opt-out,
  5 s harness timeout with a 3.5 s internal deadline, silent on every failure,
  always exit 0. `ApiClient` regains an optional request timeout.

## Approach

1. `agent/hook.ts` keeps the shared pieces (stdin reader, opt-out, id shape,
   JSON line, deadline) and the session-start entry; new
   `agent/hook-tool-failure.ts` holds key extraction, the daemon query, the
   pointer text and the per-session state. `cli.ts` adds
   `hook tool-failure`.
2. Plugin: `PostToolUseFailure` entry in `hooks/hooks.json`; new
   `hooks/codex.json` (SessionStart only) named by `.codex-plugin/plugin.json`;
   manifests 1.2.0 → 1.3.0.
3. `ApiClient` timeout option; `SKILL.md` line telling the agent to read a
   ClaudeScope earlier-occurrence note before re-diagnosing.
4. Docs: plugin README section, root README sentence, CLAUDE.md gotcha
   extension (two hooks files, never provision), this plan + index row.
5. Review, `npm test`, `npm run typecheck`, `npm run build`, markdownlint,
   plugin validation, built-CLI smoke against the sandboxed fixture daemon.

## Files affected

- `packages/server/src/agent/hook.ts` — shared helpers exported; deadline back.
- `packages/server/src/agent/hook-tool-failure.ts` — new.
- `packages/server/src/agent/api-client.ts` — `timeoutMs` option.
- `packages/server/src/cli.ts` — `hook tool-failure` dispatch and help.
- `plugins/claudescope/hooks/hooks.json`, `plugins/claudescope/hooks/codex.json`
  (new), `plugins/claudescope/.codex-plugin/plugin.json`,
  `plugins/claudescope/.claude-plugin/plugin.json`,
  `plugins/claudescope/skills/history/SKILL.md`, `plugins/claudescope/README.md`.
- `README.md`, `CLAUDE.md`, `docs/plans/README.md`.
- Tests: `test/hook-tool-failure.test.ts` (new), `test/hook.test.ts`
  (hooks-file parity).

## Testing

- Unit, the edges that would make it noisy or unsafe: key line from a Node
  trace with the version footer, from a zsh `no matches found`, from a
  `stderr:`-labelled line; harness texts and a bare `Exit code 1` → silence;
  hits from the current session dropped; ids/uuids that are not command-line
  safe dropped; no daemon record or dead pid → no request; a rejected or
  hanging request → silence under the deadline; the second identical failure
  in a session is silent while a different error still fires; the state file
  is owner-only.
- `npm test`, `npm run typecheck`, `npm run build`, markdownlint,
  `claude plugin validate ./plugins/claudescope --strict`.
- E2E: with the `verify` skill's sandboxed fixture daemon, pipe a synthetic
  `PostToolUseFailure` payload whose error matches a fixture's failed tool
  result and check the JSON line; a payload with an unmatched error prints
  nothing.

## Risks / open questions

- The key-line heuristic will miss some errors and pick a noisy line for
  others; a miss costs nothing, a noisy line costs one wasted local query.
- Cross-project recurrences (a missing tool, an expired token) are invisible
  by design; revisit if the skill analytics show the on-demand path missing
  them.
- MCP error bodies can carry secrets. The key is only sent to the local daemon
  as a search needle and is never injected; the state file stores keys, so it
  inherits the same content as the transcript it came from.
- Silent unless the daemon is already running; documented, same as the
  compaction hook. The index lags one reindex interval, which only matters for
  hits in the current session, which are excluded anyway.
- Codex users get nothing from this PR; documented in the plugin README.
