# 0045 — Indexing UX + post-update self-healing

- **Status:** in-progress
- **Date:** 2026-07-13
- **PR:** PR 1 (indexing visibility): [#58](https://github.com/vladar107/claudescope/pull/58) · PR 2 (update nudge): TBD · PR 3 (self-healing): [#57](https://github.com/vladar107/claudescope/pull/57)

## Context

Two UX gaps:

1. **First start looks broken.** The server intentionally listens before the
   index exists and builds it in the background (`packages/server/src/index.ts`).
   `/api/health` already returns `ready: isIndexReady()`, but no UI code reads
   it: `BrowsePage` fetches `/api/projects` once, gets `[]` mid-build, and shows
   "No projects indexed yet." — indistinguishable from a machine with no
   transcripts. No polling exists anywhere in the web app; the server tracks no
   progress counts.
2. **Updates don't take effect until a manual restart.** The schema-signature
   check + discard/rebuild run only at process startup (`db/duckdb.ts`,
   connection singleton), and the daemon is long-lived and detached. Only the
   npm path of `claudescope update` restarts the daemon; brew/nix get a printed
   hint, out-of-band upgrades get nothing. The version-skew warning
   (`daemon.ts`) is stderr-only and fires only on the query/MCP paths.

A schema bump triggers a full rebuild — exactly when indexing is slowest — so
one progress UX covers both first start and post-update rebuilds.

## Goal

The UI always distinguishes "index building (with live progress, list growing)"
from "genuinely nothing found"; after any update (npm/brew/nix/out-of-band) the
daemon migrates itself to the new version without a manual
`claudescope restart`; the sidebar nudges when a newer version is published.

## Decisions

- **Extend `/api/health`, no new endpoint** — the handler already returns
  `ready` beyond its declared type (fixed here); new fields read in-memory
  state so health stays cheap for liveness probes; optional fields degrade
  gracefully across old/new CLI–daemon combinations (a new `/api/status` would
  404 against an old daemon).
- **Polling, not SSE** — localhost single-user app; the UI polls health at 1s
  only while building and stops entirely once ready + idle.
- **Mid-pass partial finalization** — `/api/projects` reads the derived
  `sessions` table, which was rebuilt only at the *end* of a pass; a
  live-growing list therefore requires a throttled (3s) mid-pass
  `electCanonicalUsage` + `rebuildSessions`, gated on `!ready` so steady-state
  passes are unchanged. FTS rebuild + CHECKPOINT (WAL-hazardous) stay
  end-of-pass only.
- **Installed-version detection spawns `<bin> version`** — `claudescope
  version` prints the bare version with no side effects; works identically for
  npm symlinks, brew Cellar symlinks, and the nix `makeWrapper` script (where a
  `package.json` walk from the realpathed bin would fail).
- **Self-heal hands off via `spawn(bin, ['restart', '--no-open'])`** — the CLI
  already owns the race-free stop→wait→start sequence and spawns the *new*
  bundle's `server.js`; a marker file (`~/.claudescope/self-restart.json`, one
  attempt per target version per hour) plus a `restartInitiated` flag guard
  against restart loops and spawn storms. Never fires mid-reindex or before
  ready. Opt-out: `CLAUDESCOPE_AUTO_RESTART=0`.
- **CLI heals too** — `claudescope start` and `ensureDaemon` (queries/MCP)
  restart a healthy-but-version-skewed daemon instead of warn-only, so any CLI
  touch aligns daemon and installed code.

## Approach

Three PRs; PR 1 ∥ PR 3 independent, PR 2 after PR 1 (its sidebar hint consumes
PR 1's `StatusProvider`).

1. **PR 1 — indexing visibility.** Shared `IndexingProgress` +
   `HealthResponse.ready`/`indexing?`; progress counter (skipped files still
   advance it; cleared in `finally`) + mid-pass partial finalization in
   `data/index.ts`; `StatusProvider` health poller (1s while building, 5s while
   unreachable, stops when idle); BrowsePage: live label
   ("Indexing N of M transcripts…" / "Finishing up the index…"), silently
   growing grid, and a ready+empty state that lists the watched source dirs
   (or says none were found).
2. **PR 2 — update nudge.** Extract the 24h-cached npm-registry check from
   `cli.ts` into `update-check.ts`; daemon refreshes it hourly (network ≤
   1/day) and exposes `updateAvailable` on `/api/health`; sidebar renders a
   muted "vX.Y.Z available — `claudescope update`" hint.
3. **PR 3 — self-healing.** New `self-restart.ts` (resolve bin on PATH → spawn
   `version` → compare → marker-guarded detached `restart --no-open`), a 5-min
   daemon timer (`SELF_RESTART_INTERVAL_MS`, 0 disables, dev builds skip);
   `fetchDaemonHealth` + `terminateDaemon` extraction; skew-restart in
   `start()` and `ensureDaemon`.

## Files affected

- `packages/shared/src/api.ts` — `IndexingProgress`, `HealthResponse` (+
  `updateAvailable` in PR 2).
- `packages/server/src/data/index.ts` — progress state, changed-set precompute,
  partial finalization (+ `isReindexInFlight` in PR 3).
- `packages/server/src/routes/index.ts` — health payload.
- `packages/server/src/agent/api-client.ts` — drop the `& { ready }` patch.
- `packages/web/src/status/StatusProvider.tsx` (new), `main.tsx`,
  `pages/browse/BrowsePage.tsx`, `pages/browse/browse.css` — poller + states.
- `packages/server/src/update-check.ts` (new, PR 2), `src/index.ts` timers,
  `App.tsx` sidebar hint.
- `packages/server/src/self-restart.ts` (new, PR 3), `daemon.ts`, `cli.ts`,
  `config.ts`.

## Testing

- `index-progress.integration.test.ts` — monotonic counter with a stable total,
  skipped-unreadable file still reaches `processed === total`, sessions grow
  mid-first-build (`PARTIAL_REBUILD_MS=0`), no-change pass exposes no
  `indexing` key.
- `update-check.test.ts` (PR 2) — `isNewer` edge inputs, cache TTL behavior,
  `updateAvailable` gating.
- `self-restart.test.ts` (PR 3) — bin resolution, `version`-spawn parsing
  (garbage/timeout → null), `shouldSelfRestart` loop-guard matrix; `cli.test.ts`
  ensureDaemon skew paths via injectable probes.
- Manual: fresh `CLAUDESCOPE_HOME` first start shows live progress and a
  growing grid; tampered `schema_signature` rebuild shows the same; two bundled
  versions exercise self-heal + loop guard; `CLAUDESCOPE_AUTO_RESTART=0` warns
  and adopts.

## Risks / open questions

- Mid-pass `rebuildSessions` cost — throttled to 1/3s and first-build-only;
  fallback is counter-only UX (delete the block).
- Timing-based tests — sampling is per-event-loop-turn with monotonicity-style
  assertions; weakest assertions get dropped rather than shipped flaky.
- SIGTERM mid-WAL on self-restart — unchanged from today's manual `restart`,
  and strictly safer (never fires mid-reindex).
