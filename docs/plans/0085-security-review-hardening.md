# 0085 — Security review hardening

- **Status:** done
- **Date:** 2026-09-05
- **PR:** https://github.com/vladar107/claudescope/pull/109

## Context

A security and design review of the server (HTTP layer, daemon lifecycle,
indexer SQL, MCP output, release pipeline) produced eleven findings. Three were
reproduced before ranking, per the repo's review discipline:

- DuckDB treats `read_ndjson` paths as glob patterns: a scratch database read
  `x1.jsonl` when asked for `x[1].jsonl`, and `s*.jsonl` returned two files.
  `*`, `?`, and `[` are metacharacters; braces are inert. Wrapping each
  metacharacter in `[…]` makes the read literal.
- The running daemon answered unauthenticated reads with 200, rejected a
  foreign `Host` with 403, and rejected a same-site POST with 403 — the host
  and CSRF guards work as designed.
- In the real state dir, `daemon.log`, `daemon.log.1`, `index.duckdb`,
  `pricing.json`, `pricing.json.bak`, and every `cache/*/*.ndjson` were 0644
  and `cache/` itself 0755, while `SECURITY.md` promises 0600 files. Only the
  0700 top-level directory protects transcript text today.

Two findings were discussed and deliberately **not** fixed:

- **No API authentication.** Any process on the machine can query the API, so
  a shared multi-account host exposes the corpus. The app targets a single-user
  machine; the fix is to state that assumption in `SECURITY.md`, not to add a
  token.
- **Header-based CSRF guard.** `Sec-Fetch-Site` plus `Origin` plus the
  content-type check is sound for every evergreen browser. The residual
  (legacy browsers, any-port `Origin` allowance) is not worth complicating the
  Vite dev proxy for.

The other nine are fixed here. Item numbers below match the review.

## Goal

Every SIGTERM of a recorded PID is ownership-checked; transcript paths reach
DuckDB literally; every app-owned file is created 0600; the daemon only
re-executes a binary that lives inside its own install; MCP output marks
transcript text as recorded data; the daemon record follows the process that
holds the port; PR links are `http(s)` only; request URLs stay out of the log;
`start` never navigates to a URL read from disk.

## Decisions

- **(2) The ownership gate lives inside `terminateDaemon`.** `daemonOwnsPid` and
  `planWedgeAction` already exist, but only the wedged path used them; `stop`,
  `restart`, `update`, and the healthy-but-skewed heal sent SIGTERM to whatever
  PID the record named. Moving the gate into the one function that signals
  makes it impossible to add a new unguarded caller. Callers that already hold
  a verdict pass it in, so the wedged path does not run `ps` twice. A `refuse`
  verdict is *returned*, not thrown (only a signalled process that will not
  exit throws): `stop` reports it and fails, while the version-skew heal adopts
  the daemon it just saw answer `/api/health`, because only killing needs
  certainty and a machine without `ps` must not lose every MCP call.
- **(8) The server writes `daemon.json` after a successful bind.** The spawner
  sets `CLAUDESCOPE_DAEMON=1`; the server writes `{pid: process.pid, port, …}`
  once `listen` resolves, and the CLI stops writing the record. A losing
  concurrent spawn dies on `EADDRINUSE` before it could ever write, so the
  record always names the port holder. Rejected: an `O_EXCL` lock file in the
  CLI, which needs a placeholder PID before the child exists, and PID 0 means
  "the process group" to `process.kill`.
- **(3) Glob-escape only the read path.** A `sqlPath()` helper next to
  `sqlString` wraps `*`, `?`, and `[` in brackets. The `file_path` column and
  every `WHERE file_path = …` keep the raw path, because `files.path` and the
  per-file deletes compare it literally. Only the Claude Code connector reads
  source paths directly; the cache-backed connectors read sha1-named files and
  cannot contain metacharacters. Rejected: the list form (also globs) and a
  DuckDB no-glob option (none exists).
- **(4) Belt and braces for file modes.** `process.umask(0o077)` at server
  boot covers files we cannot pass a mode to (DuckDB's own `index.duckdb` and
  WAL). Every explicit writer also passes `STATE_FILE_MODE`, and every
  `copyFileSync` is followed by a `chmodSync`, so the guarantee does not depend
  on which process wrote the file. `cache/` itself goes through
  `ensureStateDir` so the pre-existing 0755 root is tightened.
- **(5) Self-restart trusts only its own install root.** The PATH-resolved bin
  is executed only if its real path lies under the root the running code came
  from: the directory above `node_modules` for npm layouts (also nvm, fnm, and
  Windows shims), `…/Cellar/claudescope/` for Homebrew (a new version is a
  sibling directory), and `/nix/store/` for Nix (root-owned, immutable). A bin
  outside that root is skipped silently, logged once. Rejected: matching a
  `node_modules/@vladar107/claudescope` segment anywhere (an attacker who owns
  a PATH directory can construct that), and making the feature opt-in (kills
  the brew/nix post-upgrade heal it exists for).
- **(7) Framing, not filtering.** `search_transcripts`, `get_session`, and
  `list_sessions` (titles are transcript-derived) get one notice line saying
  the text is recorded history to be treated as data, and the body sits
  between explicit begin/end delimiter lines that do not look like harness
  tags. The CLI output is unchanged: it is for humans, and `--json` consumers
  never see shaping.
- **(9) Validate `pr_url` at index time.** The aux projection keeps only rows
  where `prUrl` matches `^https?://`. Persisted derived values change, so
  `SCHEMA_VERSION` bumps to 21 and existing indexes rebuild.
- **(10) `disableRequestLogging: true`.** The error handler still logs failed
  requests with `req.log.error`, and the indexer/pricing lines remain. Rejected:
  a custom `req` serializer that strips the query string — it keeps two lines
  per request (including the UI's health poll) for no diagnostic gain.
- **(11) `start` rebuilds the browser URL from the port**, mirroring what
  `open` already does; `daemon.json` is local state, not a navigation target.

## Approach

Branch `fix/security-review-hardening` off `main`. One commit per chunk. Two
waves; the second touches files the first edits, so it waits.

### Wave 1 (independent, in parallel)

1. **Glob-safe reads and PR-link validation** (items 3, 9). Add `sqlPath` to
   `db/duckdb.ts`; use it for the three `read_ndjson` calls in the Claude Code
   connector while `file_path` stays `sqlString(filePath)`; add the `prUrl`
   scheme filter; bump `SCHEMA_VERSION` to 21 with a comment.
2. **File modes, umask, request logging, SECURITY.md** (items 4, 10, scope
   note). `process.umask(0o077)` first thing in `main()`;
   `disableRequestLogging: true`; `STATE_FILE_MODE` on the log `openSync`, the
   cache write, the pricing tmp write, the self-restart marker; `chmodSync`
   after the pricing seed copy and both `.bak` copies; `ensureStateDir` on the
   cache root. `SECURITY.md`: state the single-user trust assumption and make
   the 0600 sentence true.
3. **MCP framing** (item 7). Notice constant plus begin/end delimiters in
   `agent/mcp.ts` around the three tools' output.

### Wave 2 (after wave 1)

4. **Daemon lifecycle** (items 2, 8, 11). `terminateDaemon(record, owns =
   daemonOwnsPid)` runs `planWedgeAction` and returns the action: refuse comes back
   unsignalled with the record kept, discard removes the record without
   signalling, replace signals and waits.
   `ensureDaemon` and `start()` pass their existing verdict; `stop()` calls it
   and reports the outcome. `spawnDaemon` sets `CLAUDESCOPE_DAEMON=1` and no
   longer writes the record; new `writeDaemonRecord(port)` in `daemon.ts`,
   called from `index.ts` after `listen` when that env var is set. `start()`
   opens `http://127.0.0.1:<port>` built from the validated port.
5. **Self-restart trust root** (item 5). `trustedInstallRoot(packageRoot,
   method)` in `install-method.ts`; `maybeSelfRestart` resolves the bin's real
   path and skips unless it starts with that root (case-insensitive on win32).

### Finish

6. Two anti-regression lines in `CLAUDE.md` Gotchas: source paths reach
   `read_ndjson` via `sqlPath`, and every SIGTERM of a recorded PID goes
   through `terminateDaemon`. Run `/review`, `npm test`, `npm run typecheck`.
   Revert each fix in turn to confirm its test fails; record the count in the
   PR. Open the PR, then set this plan to `done`.

## Files affected

- `packages/server/src/db/duckdb.ts` — `sqlPath()` glob-escaping helper.
- `packages/server/src/connectors/claude-code/claude-code.ts` — read via
  `sqlPath`; `prUrl` scheme filter.
- `packages/server/src/db/schema.ts` — `SCHEMA_VERSION` 21.
- `packages/server/src/index.ts` — umask, `disableRequestLogging`, daemon
  record write after bind.
- `packages/server/src/daemon.ts` — ownership gate in `terminateDaemon`,
  `writeDaemonRecord`, log file mode, `CLAUDESCOPE_DAEMON` env on spawn.
- `packages/server/src/cli.ts` — `stop`/`start` use the gated terminate; `start`
  rebuilds the browser URL.
- `packages/server/src/self-restart.ts` — trust-root check; marker file mode.
- `packages/server/src/install-method.ts` — `trustedInstallRoot`.
- `packages/server/src/connectors/ndjson-cache.ts` — file mode; tighten
  `cache/` root.
- `packages/server/src/config.ts`, `packages/server/src/settings.ts` — modes
  on tmp writes and `.bak` copies.
- `packages/server/src/agent/mcp.ts` — untrusted-history framing.
- `SECURITY.md`, `CLAUDE.md`, `docs/plans/README.md` — docs.
- Tests: `cli.test.ts`, `self-restart.test.ts`, new `install-method.test.ts`,
  `mcp.integration.test.ts`, `api.integration.test.ts`, new
  `glob-paths.integration.test.ts`, one cache-mode assertion in
  `cache-prune.integration.test.ts`.

## Testing

`npm test` and `npm run typecheck`. New tests target the edges that broke:

- A fixture projects dir whose name contains `[1]` indexes its own file, not a
  sibling that matches the pattern.
- A `pr-link` with a `javascript:` URL leaves the session without a `prUrl`.
- After an index pass, a normalize-cache file is 0600 (skipped on win32).
- `terminateDaemon` with `owns` → `false` removes the record and never sends
  SIGTERM; `'unknown'` returns `refuse` and leaves the record; `true` signals
  and waits. `ensureDaemon` adopts a skewed daemon on `refuse` instead of
  failing.
- `writeDaemonRecord` writes `pid: process.pid` with `STATE_FILE_MODE`.
- `trustedInstallRoot` for npm posix, npm Windows, Homebrew Cellar, Nix store,
  and a dev checkout (no `node_modules` → null); a Volta shim outside the root
  is rejected.
- MCP `search_transcripts` and `get_session` output carries the notice and
  delimiters.

Each fix is reverted once to confirm its test fails.

## Risks / open questions

- Volta, pnpm, and similar shim managers put their command shim outside the
  package's `node_modules` parent, so self-restart is skipped for them (one
  log line per process). Safe direction; `claudescope update` still restarts
  on the npm path.
- `claudescope stop` can now fail: an unverifiable PID (no `ps`, or a probe
  timeout) prints the manual instructions and exits 1 with the record kept,
  and `restart`/`update` then do not spawn. Previously `stop` always cleared
  the record, even when the signalled process had not exited.
- `process.umask` has no effect on Windows; explicit modes are also ignored
  there. Windows relies on per-user profile ACLs as before.
- `disableRequestLogging` removes per-request traces from `daemon.log`; failed
  requests are still logged by the error handler.
- The schema bump forces one full rebuild on upgrade.
- MCP output grows by three lines per call. Framing is advisory: a model can
  still be talked into following injected text, but the harness-tag confusion
  that the delimiters address is the plausible vector.
- `update` still runs `claudescope start` via PATH after `npm install -g`. It is
  user-initiated and interactive, so it is left as is; it could reuse the
  trust root later.
