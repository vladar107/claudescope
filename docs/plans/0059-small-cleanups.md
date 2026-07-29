# 0059 — Three small cleanups from the review

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-29
- **PR:** https://github.com/vladar107/claudescope/pull/79

## Context

Last of the eight PRs from the repo-wide review. Three items I listed as "micro"
and left until the substantive clusters were done. Two are genuinely trivial; the
third turned out to have a real design question and an untested invariant behind
it, which is why this has a plan at all.

**1. `existsSync(WEB_DIST_DIR)` evaluated twice** (`index.ts:121,133`) — once to
decide whether to register the static handler, once to build the startup banner.

**2. `rows[0]` cast and read twice** (`sessions.ts:153,159`) — `rowToSessionMeta`
reads the row, then the handler re-casts the same row to pull `project_cwd` out
for the resume command.

**3. `SET scalar_subquery_error_on_multiple_rows = false` run per request**
(`search.ts:44`). This is a **connection-level** setting, applied to the singleton
connection the indexer and every other route share — so an unrelated HTTP call
silently changed query semantics process-wide, and left them changed. It was also
order-dependent: the first search on a fresh process was what armed it.

And it was **completely untested**. Deleting the line outright left all 588 tests
green, so the one reason it exists — `match_bm25(uuid, …)` doing a scalar-subquery
lookup on a `uuid` that fork/resume copies duplicate — had no coverage at all.

## Goal

The two duplications are gone, and the DuckDB setting is a declared property of
the connection with a test that fails without it.

## Decisions

- **Write the missing test before moving the setting** — moving an untested line
  is unverified by definition. The new test builds an original session plus a fork
  that preserves its uuids (the precondition), asserts the duplicate really is in
  `events`, and then searches. It fails with `More than one row returned by a
  subquery` when the setting is absent from *either* location, so it pins the
  behaviour rather than the placement.
- **Apply it at connection open, not per request** — rejected keeping it in the
  handler but guarding it with a module-level "already done" flag: that is still
  lazy hidden global initialisation, just cheaper. Rejected set-then-reset around
  the query: with a shared connection, a reset can land while another search is
  in flight. Open time makes it deterministic instead of dependent on whether a
  search has run yet.
- **Accept that the indexer now always runs with the relaxed setting** — before,
  a fresh process's initial build ran with it strict and only searches relaxed it.
  Every scalar subquery in the indexer is `LIMIT 1`-bounded, so there is no
  practical change; and "deterministic for all queries" beats "strict until
  someone searches". Called out because it is a real, if small, semantic shift.

## Approach

1. `test/search-forked.integration.test.ts` — new; pin the fork/duplicate-uuid
   search path.
2. `db/duckdb.ts` — apply the setting in `openAndPrepare`, documented.
3. `routes/search.ts` — drop the per-request `SET`, leave a pointer comment.
4. `index.ts` — hoist `servesWeb`.
5. `routes/sessions.ts` — hoist the row cast.

## Files affected

- `packages/server/src/db/duckdb.ts` — the setting, at open time.
- `packages/server/src/routes/search.ts` — per-request `SET` removed.
- `packages/server/src/index.ts` — `servesWeb` hoisted.
- `packages/server/src/routes/sessions.ts` — row cast hoisted.
- `packages/server/test/search-forked.integration.test.ts` — new.

## Testing

- `npm test` (588 → 591), `npm run typecheck`, `npm run build`, markdownlint.
- The new test fails (2 cases) with the setting removed from the handler, and
  fails identically with it removed from `openAndPrepare` — so it verifies the
  behaviour at the new location, not just that a line exists somewhere.
- `openAndPrepare` is also the path the corrupt-DB recovery and the explicit
  index rebuild take (`closeConnection` → `discardDbFiles` → `getConnection`), so
  a rebuilt connection gets the setting too.

## Risks / open questions

- Relaxing the setting for indexer queries could in principle mask a genuine
  multi-row scalar subquery there. Reviewed: all of them are `LIMIT 1`. If one is
  ever added without a bound, it will silently pick a row rather than error.
- The underlying cause is untouched: `events.uuid` is not unique. Making the FTS
  key genuinely unique (or de-duplicating fork copies before indexing) would remove
  the need for the setting entirely — a bigger change, and the duplicates are
  identical so there is no wrong answer today.
