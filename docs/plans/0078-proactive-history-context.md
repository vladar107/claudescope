# 0078 — Proactive history context

- **Status:** done
- **Date:** 2026-09-02
- **PR:** https://github.com/vladar107/claudescope/pull/101

## Context

Issue [#100](https://github.com/vladar107/claudescope/issues/100) measured one
month of local transcripts (92 sessions): the `history` skill launched four
times, never on the agent's own initiative, while the moments where history
would have paid off passed unnoticed — branches worked across 10+ sessions with
no handoff, "where did we stop" questions right after a context compaction, the
same tool error re-diagnosed in three sessions. The skill fires only on explicit
history phrasing, and that demand is low by nature.

Two constraints in the current code shape the fix:

- Every query subcommand runs through `ensureDaemon()`, which always ends in a
  spawn plus a 30 s health wait and restarts a healthy daemon on version skew.
  A session-start hook cannot reuse it.
- Plan 0069 deliberately kept the plugin skills-only ("no hooks"). This plan
  supersedes that decision for one narrow trigger: after a compaction the
  harness knows something the model cannot (that context was lost, and which
  session id holds the full transcript), and only a hook can pass it on.

Both harnesses auto-discover `hooks/hooks.json` at the plugin root, support
`SessionStart` with regex matchers, and accept the JSON
`hookSpecificOutput.additionalContext` stdout form. Both send a required
`source` with the same four values (`startup`, `resume`, `clear`, `compact`).
Codex gates each hook behind a one-time trust step (`/hooks`); Claude Code
cannot disable a single plugin hook.

## Goal

An agent whose context was just compacted is told, without asking, that the
full transcript is still readable locally and how to read its end. The CLI
exposes the filters that make picking up earlier work one command (`--branch`,
`--cwd`, `--tail`), and the skill description names the moments where history
is worth consulting, so the judgment-based path has both the trigger and the
recipe.

## Decisions

- **Hook on `compact` only** — the first cut also injected up to three recent
  sessions for the project + branch on `startup`/`resume`/`clear`. Dropped in
  review: that puts untrusted session titles into every session's context
  whether or not the work continues anything, `resume` already restores the
  transcript, and `clear` is the user asking for a fresh context. The
  compaction pointer is different in kind — one line of trusted text, fired
  only when context was actually lost, carrying the session id the model
  cannot otherwise know.
- **The hook answers from stdin alone** — no daemon probe, no detached
  `spawnDaemon()`, no git, no HTTP. Nothing in it can block a session, and
  `ensureDaemon()` stays out of the hook path. On by default in the same
  plugin, env opt-out `CLAUDESCOPE_HOOKS=0`; Codex already asks trust per hook.
- **Pointer, not content, after compaction** — only the recovery command
  (`session <id> --tail 20 --redact`); injecting transcript text right after a
  compaction defeats the compaction.
- **Startup and resume stay on demand** — the widened skill description
  triggers on need (a branch whose earlier progress is not in context, "where
  did we stop", a familiar error), not on session start. Whether it fires on
  its own is measurable with plan 0079's `analytics --group-by skill`; a push
  mechanism for those moments is a decision for after that data exists.
- **One `hooks.json` for both harnesses** — an inline `sh -c` command that
  checks `command -v claudescope` and always exits 0, so no plugin-root variable
  is needed and a missing CLI is silent. Matcher `compact`; the hook also
  checks `source` itself, so a broader matcher copied into a user's own
  settings still gets silence on the other triggers.
- **JSON stdout form** —
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}`
  is the form both harnesses document for context injection.
- **`--cwd` resolves locally** — the project id is a hash of the cwd
  (`projectIdFromCwd`), so the CLI and MCP map `--cwd` to `project` without a
  server change; agents skip the `projects` listing.
- **`--tail` is a server window mode** — `resolveWindow` gains `tail`; the CLI
  rejects it alongside `--offset/--limit/--around` (usage error), the route with
  400. A client-side two-request tail was rejected: MCP and the web would not
  benefit.
- **Literal search and tool/skill analytics are PR 2** (plan 0079); a
  tool-failure hook that runs a literal search for the error string is the
  natural PR 3 once those land.

## Approach

1. Branch filter and tail window: `SessionsQuery.branch`, `SessionDetailQuery.tail`,
   list route `git_branch =` filter, `resolveWindow` tail mode, route gate + 400
   on conflicts, `shape.ts` window args, CLI flags/help/BRANCH column, MCP params
   (`branch`, `cwd`, `tail`).
2. Plugin: `hooks/hooks.json` (matcher `compact`), widened `SKILL.md` (triggers
   + resume recipe + new flags), README hook section, manifests 1.1.0 → 1.2.0,
   Codex default prompt.
3. Docs: this plan + index row, root README (`--cwd/--branch/--tail`, weekly
   digest cron line), one CLAUDE.md anti-regression bullet.
4. `claudescope hook session-start` (`agent/hook.ts`, two-level dispatch like
   `pricing update`): stdin JSON (`source`, `session_id`), opt-out, output
   composition, always exit 0.
5. Review, `npm test`, `npm run typecheck`, `npm run build`, plugin validation,
   e2e hook run.

## Files affected

- `packages/shared/src/api.ts` — `branch` on `SessionsQuery`, `tail` on
  `SessionDetailQuery`.
- `packages/server/src/routes/sessions.ts` — branch filter; `tail` in the
  window gate; 400 on tail + offset/limit/around.
- `packages/server/src/data/window.ts` — tail mode in `resolveWindow`.
- `packages/server/src/agent/shape.ts` — `tail` in `WindowArgs` /
  `resolveWindowArgs`; `projectIdForCwd`.
- `packages/server/src/agent/query.ts` — `--cwd` → project, BRANCH column,
  tail passthrough.
- `packages/server/src/agent/mcp.ts` — `branch` / `cwd` on `list_sessions`,
  `tail` on `get_session`.
- `packages/server/src/agent/hook.ts` — new: the compaction pointer in the
  harness JSON form.
- `packages/server/src/cli.ts` — flags, help, `hook session-start` dispatch.
- `plugins/claudescope/hooks/hooks.json` — new.
- `plugins/claudescope/skills/history/SKILL.md`, `plugins/claudescope/README.md`,
  `plugins/claudescope/.claude-plugin/plugin.json`,
  `plugins/claudescope/.codex-plugin/plugin.json`.
- `README.md`, `CLAUDE.md`, `docs/plans/README.md`.
- Tests: `test/window.test.ts`, `test/api.integration.test.ts`,
  `test/hook.test.ts` (new).

## Testing

- `npm test`, `npm run typecheck`, `npm run build`.
- `claude plugin validate . --strict` and
  `claude plugin validate ./plugins/claudescope --strict`.
- Unit: tail clamps past the end; tail vs around precedence; the hook stays
  quiet on `startup`/`resume`/`clear` even when a matcher lets them through;
  compact emits the recovery command; opt-out; malformed stdin or an unsafe
  session id → empty output, exit 0.
- Integration: `?branch=` exact match against a fixture on another branch;
  `?tail=2` returns `{offset: total-2, limit: 2, total}`; tail + offset → 400.
- E2E: pipe a synthetic compact payload into the built
  `claudescope hook session-start` and check the JSON line; a startup payload
  prints nothing.

## Risks / open questions

- Claude Code users cannot disable the hook short of the env var or removing
  the plugin; documented in the plugin README.
- Reindex lag: the compaction pointer relies on the session file having been
  re-indexed; `session` starts the daemon and indexes on demand, so the worst
  case is a short wait, not a miss.
- The inline `sh -c` hook command assumes a POSIX shell; the Windows behaviour
  of both harnesses' hook runners is unverified.
- Follow-up (PR 3): a tool-failure hook (`PostToolUseFailure` / Codex
  equivalent) running `search --literal` on the error string, once plan 0079
  lands.
