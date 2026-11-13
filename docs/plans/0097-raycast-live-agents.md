# 0097 — Live agents in Raycast: `claudescope live` and `detail=full`

- **Status:** done
- **Date:** 2026-11-13
- **PR:** [#137](https://github.com/vladar107/claudescope/pull/137)

## Context

The web Live tab (plan 0095) shows what each recently written session is doing,
read off its transcript tail by `GET /api/live`. The Raycast extension
(`claudescope-raycast` repo) talks to Claudescope only through the CLI on
`PATH`, so it has no way to show the same view. A Raycast list command refreshes
by polling, about every 5 seconds.

The Live payload is shaped for cards: `lastText` collapses whitespace and stops
at 200 characters, and each string of an open tool call's input stops at 200
characters too. A Raycast detail pane has room for the full reply and command.

## Goal

A read-only `claudescope live` subcommand that a Raycast "Live Agents" list
command can poll, plus an opt-in fuller payload on `GET /api/live`, without
changing anything the web Live tab receives.

## Decisions

- **`live` never starts the daemon.** Every other query subcommand goes through
  `runQuery` → `ensureDaemon()`, which spawns a daemon (waiting up to 30 s) and
  replaces a running one on version skew. A 5 s poller doing that would restart
  the server seconds after `claudescope stop`, and would kill and respawn a
  daemon whenever the CLI on `PATH` and the running server disagree on version.
  `live` instead reads `daemon.json` and asks `classifyExisting(…, isAlive,
  isHealthy)`, the same alive-and-answering check `status` makes. Anything but
  `healthy` (no record, a dead PID, a recorded daemon that does not answer)
  prints `✗ claudescope is not running (start it with: claudescope start)` to
  stderr and exits 3, so the poller can tell "stopped" from a failed request
  (exit 1). Rejected: a `--no-start` flag on every query command, which would
  leave the default unsafe for the one caller that polls.
- **`detail=full` is opt-in on the existing route**, not a new endpoint. With
  it, `lastText` keeps its newlines (trimmed only) and is capped at 4000
  characters, and every string inside `openTool.input` (main thread and each
  run) is capped at 4000 instead of 200. Any other `detail` value behaves like
  none, and without it the body is byte-for-byte unchanged, so the web tab's
  ETags stay valid.
- **One derived-result cache per variant.** `GET /api/live` caches each
  session's derived state by id. The two variants keep separate maps, so a full
  request can never be served a capped entry (or the reverse), and a web tab and
  a Raycast poller alternating on the same session don't evict each other's
  entry. Rejected: storing uncapped text and capping at serialization, which
  would keep up to 4000 characters per string in the cache for the web tab too.
- **Menu-bar item is out of scope.** Only a Raycast list command ships here.

## Approach

1. `deriveLiveState` takes `full`; it picks the text caps and skips the
   whitespace collapse for `lastText`.
2. The route reads `detail`, chooses the cache map, and passes `full` through.
3. `ApiClient.live` and `queryLive` (a short listing, or `--json` for the raw
   body); `claudescope live [--window 5|15|60] [--full] [--json]` validates the
   window before any daemon contact and uses the non-spawning check above.
4. Companion change in `claudescope-raycast`: a "Live Agents" list command that
   runs `claudescope live --json --full` every 5 s and shows the exit-3 case as
   "Claudescope is not running".

## Files affected

- `packages/server/src/data/live-state.ts` — `full` caps.
- `packages/server/src/routes/live.ts` — `detail=full`, per-variant cache.
- `packages/shared/src/api.ts` — `LiveQuery`.
- `packages/server/src/agent/api-client.ts`, `agent/query.ts` — `live()` and
  `queryLive`.
- `packages/server/src/cli.ts` — the `live` subcommand and help.
- `README.md`, `CLAUDE.md` — command lists.
- Tests: `live.integration.test.ts` (cache crossover), `cli.test.ts` (window
  validation before daemon contact, exit 3 without spawning).

## Testing

`npm test` and `npm run typecheck`. The crossover test requests default, then
`detail=full`, then default again on one session inside the 1 s re-derive
floor, and fails if the variants share a cache entry. The CLI tests assert that
an invalid `--window` never probes the PID or fetches, and that with no record
or an unanswering one `live` exits 3 with nothing spawned or signalled.

## Risks / open questions

- The Raycast command needs a Claudescope release that ships `live`; older
  installs print "Unknown command" and exit 1, which the extension should show
  as "update Claudescope".
