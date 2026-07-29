# 0052 — Indexer durability + state-dir permissions

- **Status:** in-progress <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-29
- **PR:** <link, once opened>

## Context

A repo-wide review turned up two problems that lose or expose data. Both were
reproduced against a real DuckDB index before this plan was written.

**1. A pricing typo silently destroys indexed events.** `loadFile` deletes a
file's `titles`/`pr_links`/`events` rows and then re-inserts them. The cost
expression is built by string interpolation from `pricing.json`, and
`loadPricing` does a bare `JSON.parse(...) as PricingConfig` with no validation
— so a rate typed as a string (`"3.00 USD"`, a plausible hand-edit of a file the
docs invite you to edit) produces invalid SQL. Which half of the pass fails
depends on *where* the typo is:

- in `models` → fails in `syncPricingTable`, **before** the deletes → data frozen;
- in `families`/`default` → those are inlined into the cost expression by
  `buildCostExpr`, so it fails in `INSERT INTO events`, **after** the deletes →
  **data destroyed** (measured: 3 events → 0, `sessions` still advertising
  `message_count: 3`).

Same user action, opposite outcomes, decided by statement order. It compounds:
another changed file is wiped on every subsequent pass.

**2. The failure is invisible.** The per-file `catch` in `doReindex` warns to
`console` and continues without incrementing `reindexed`, so the pass hits the
`reindexed === 0 && removed === 0` early return and reports
`{reindexed: 0, durationMs: 5}` — byte-identical to a genuinely idle pass. The
poller's `if (res.reindexed > 0)` guard means it does not even log; `dataVersion`
never moves so the web UI never refetches; `/api/health` reports a healthy
`watching` indexer. Ingestion stops permanently while the app looks fine. This is
generic — *any* per-file load failure is laundered into "nothing changed".

**3. Two smaller defects in the same pass.** `modal_cwd`'s `row_number()` has no
tie-break column, so a session whose two most-frequent cwds tie flips between
projects (both values observed across 20 evaluations of identical data).
`editBearing` builds one unchunked `IN (...)` list — 147 KB of SQL at 5k
sessions — directly below a `DELETE` that chunks at 500 for exactly that reason.

**4. The state dir downgrades source protection.** `~/.claude/projects` is
`0700`; Claudescope re-materializes its content into `~/.claudescope/` at `0755`
with `index.duckdb` at `0644` — 157 MB of transcript text plus a full FTS index,
world-readable, on the reviewer's own machine. The index aggregates every
connector, so it inherits the loosest posture of any source rather than the
strictest.

## Goal

A per-file load failure can no longer lose data, can no longer masquerade as an
idle pass, and app-owned state is owner-only. Derived-table output becomes
deterministic for tied cwds.

## Decisions

- **Wrap `loadFile`'s mutations in a DuckDB transaction** — rather than
  reordering statements so the interpolation failure happens earlier. Ordering
  luck is what makes the current behaviour inconsistent; a transaction makes
  *any* mid-load failure a no-op regardless of which statement throws. Verified
  `BEGIN`/`ROLLBACK` work through `conn.run` on `@duckdb/node-api`.
- **Validate pricing rates in `loadPricing`, don't throw** — an unusable rate is
  dropped so the chain falls through (`models` entry → family → default), which
  is the philosophy `pricing-refresh.ts:mapLiteLLM` already applies to fetched
  rates. Rejected: throwing (turns a typo into a dead app) and repairing values
  (guessing at intent). `default` cannot be dropped, so invalid fields there are
  zeroed with a loud warning — visibly wrong beats invisibly wrong.
- **`failed` on `ReindexResponse`, not an exception** — the poller's non-fatal
  design and `POST /api/reindex` both depend on `reindex()` resolving.
  `IndexerStatus.lastPass` is already `ReindexResponse | null`, so the count
  surfaces on `/api/indexer/*` with no new API surface.
- **Keep the early return, but gate it on `failed === 0`** — with the
  transaction in place a failed file changes nothing, so skipping the derived
  rebuild is now *correct*; the gate is belt-and-braces so a future non-atomic
  failure path can't silently reintroduce the inconsistency.
- **One `ensureDir` helper for the state dir** — the mode has to be right at all
  five `mkdirSync(CLAUDESCOPE_HOME)` sites, and a sixth will be added eventually.
  Existing installs are migrated on boot (`chmod` when the mode is looser).

## Approach

1. `shared`: add `failed: number` to `ReindexResponse`.
2. `data/pricing.ts`: coerce every `ModelRates` through a validator on the
   cache-miss path; drop unusable `models`/`families`/`providers` entries, zero
   unusable `default` fields, warn once per file change.
3. `data/index.ts`: transaction around `loadFile`'s mutations; count and return
   `failed`; gate the early return on it; add `, cwd` to the `modal_cwd`
   tie-break.
4. `data/file-edits.ts`: chunk `editBearing` at the existing `INSERT_CHUNK`.
5. `indexer-lifecycle.ts`: log at warn level when a pass reports failures.
6. `config.ts`: `ensureDir` (mode `0700`) + `STATE_FILE_MODE` (`0600`); route the
   other four `mkdirSync` sites through it; tighten an existing looser dir on boot.
7. Regression tests for the two data-safety paths and the tie-break.

## Files affected

- `packages/shared/src/api.ts` — `ReindexResponse.failed`.
- `packages/server/src/data/pricing.ts` — rate validation on load.
- `packages/server/src/data/index.ts` — `loadFile` transaction, `failed`
  accounting, `modal_cwd` tie-break.
- `packages/server/src/data/file-edits.ts` — chunk `editBearing`.
- `packages/server/src/indexer-lifecycle.ts` — surface `failed` in the poll log.
- `packages/server/src/config.ts` — `ensureDir` / `STATE_FILE_MODE`, mode migration.
- `packages/server/src/{daemon,cli,update-check,settings}.ts` — use `ensureDir`.
- `packages/server/src/data/pricing-refresh.ts` — write the snapshot `0600`.
- `packages/server/test/index-durability.integration.test.ts` — new.
- `packages/server/test/pricing.test.ts` — validation cases.

## Testing

- `npm test` and `npm run typecheck` (baseline: 484 tests / 55 files green).
- New integration test asserts a `default`-block typo leaves `events` intact,
  reports `failed: 1`, and that a later valid pass recovers the data.
- New test asserts a tied-cwd session resolves to the same project across
  repeated evaluations.
- Manual: `stat` the state dir after boot to confirm `0700`/`0600`.

## Risks / open questions

- Per-file transactions add two statements per changed file. Measured cold-build
  cost is expected to be noise against the ~300 ms/pass baseline; the perf job
  gates it.
- `PRAGMA create_fts_index` and `CHECKPOINT` must stay **outside** the
  transaction. They already run after the per-file loop, so no change — but a
  future refactor that moves them inside would break.
- Zeroing an invalid `default` field makes affected costs read 0. The warning
  names the field; the alternative (crash) is what this plan removes.
- The mode migration only tightens `CLAUDESCOPE_HOME` itself, not pre-existing
  files inside it. `index.duckdb` is recreated on the next rebuild; a paranoid
  user can `chmod -R go-rwx ~/.claudescope`. Called out in the PR body.
