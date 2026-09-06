# 0087 — Sessions pagination, Codex walk reuse, and FTS rebuild debounce

- **Status:** done
- **Date:** 2026-09-06
- **PR:** <https://github.com/vladar107/claudescope/pull/111>

## Context

Plan 0086 fixed every finding of the codebase audit except three it deferred
to a follow-up. Re-measured on this machine before planning:

- **No default limit or pagination on the sessions list.** `GET /api/sessions`
  returns every matching row unless the caller passes `limit`; the web list
  never does, and refetches the entire list on every data-version bump. The
  client-side text filter covers title, branch, id, and models, so any paging
  scheme has to keep that filter honest across pages.
- **Codex prepare re-walks the sessions dir per file.** `getCodexContext()`
  calls `listRollouts()` (recursive readdir + stat) on every call to compute
  its fingerprint, and it is called once per subagent rollout parsed. Measured:
  158 rollouts walk in 3 ms, so the re-walk is negligible today (85 subagent
  rollouts × 3 ms on a first build). The other half of the finding — whole-file
  re-normalization of a growing rollout — costs 353 ms and a 270 MB heap spike
  per pass for the largest (68 MB) rollout, and only while that rollout is
  being appended to.
- **The FTS index is rebuilt from scratch, plus a CHECKPOINT, on every pass
  that loaded a file.** With a 15 s poll and an active agent that is every
  pass; the audit measured a 615 ms median incremental pass, and every route
  query stalls behind it on the shared connection.

## Goal

Land the three deferred items with the same discipline as 0086: each fix
carries a fitness function that encodes the rule, and the sessions list stays
correct under paging for the web, the CLI, and the MCP tool.

## Decisions

- **Paging is `offset` + `limit` with a deterministic order; the total rides
  in an `X-Total-Count` header and the body stays `SessionMeta[]`.** Every
  `ORDER BY` gets an `, id` tie-break so pages never overlap or skip on tied
  values. Rejected: a `{ rows, total }` envelope — it would ripple through the
  CLI `--json` shape, the MCP tool, and ten test files for one number.
- **`limit` defaults to 50 and clamps to 500** (`clampInt`, as
  `analytics-sessions.ts` does). "Absent = all rows" goes away; that was the
  audit finding. The CLI and MCP keep their own default of 20.
- **`q` matches title, branch, id, or model on the server** — the exact
  haystack the web filter applied client-side. The web sends `q` (debounced
  300 ms, as the search page does) and drops the client-side filter, so a
  filter can find a session on page three. CLI/MCP descriptions change from
  "title" to "title, branch, id, or model"; matches only widen.
- **The web pages with a "Load more" button, 50 rows per page, and a
  "Showing X of Y" line.** A data-version bump refetches the loaded window
  (offset 0, limit = rows loaded) so a live session's row updates without
  collapsing the list. Rejected: infinite scroll — an observer adds plumbing
  for no gain on a list this size, and a button is predictable and keyboard
  reachable.
- **Codex reuses the walk `discover()` already did.** `listRollouts()`
  remembers its last result; `getCodexContext()` fingerprints that list
  instead of walking again, so a pass walks the sessions dir exactly once.
  The read path (`loadSession`) sees at most one poll interval of staleness,
  which only matters for a grandchild spawned within the last 15 s and is
  corrected by the next pass. **Whole-file normalization stays.** Rejected:
  append-incremental parsing — a rollout's rows depend on cross-record
  correlation (call/output pairing, the spawn map, the synthesized uuid
  chain), so incremental parsing means persisting the parser's state machine
  between passes; DuckDB re-reads the whole cache file anyway; and the cost
  exists only while a very large rollout is actively growing.
- **The FTS rebuild is debounced with a trailing edge and a staleness cap.**
  After `rebuildSessions`, the pass rebuilds FTS only if the last rebuild is
  older than `FTS_REBUILD_MIN_INTERVAL_MS` (default 60 000; `0` = every pass,
  which the vitest config pins so the existing suite is unchanged). Otherwise
  it records `fts_stale` in the `meta` table and moves on. An idle pass that
  finds the flag rebuilds FTS only — not the whole finalize. `POST
  /api/reindex` always flushes: a user-initiated pass expects fresh search.
  Derived tables (`sessions`, `file_edits`) are never debounced: the list page
  is what people watch live.
- **The stale flag is persisted, not in-memory.** A restart mid-session
  (`claudescope update`, the version-skew self-restart) would otherwise leave
  ranked search stale until the next file change, because the idle
  early-return sees no work. The first pass after boot reads the flag.
- **Ranked search may lag up to a minute during continuous activity; literal
  search never does.** `searchLiteral` is a `LIKE` over `events`, so it is
  always current. Documented in the README. An FTS-only pass does not bump
  `dataVersion`: nothing the list consumers watch changed.

## Approach

Waves keep parallel work on disjoint files; at most three agents per wave.

1. **Wave 1** — three independent chunks.
   - **C1 Sessions API paging (complex).** `offset` in `SessionsQuery`;
     route clamps `limit`, adds `OFFSET`, the `, id` tie-break, the widened
     `q`, and the `X-Total-Count` header (constant exported from `shared`);
     `ApiClient.sessions`, `querySessions` (`--offset`), the MCP
     `list_sessions` schema, and the CLI help. Fitness test 1.
   - **C2 FTS debounce (complex).** `ftsStale` + `lastFtsRebuildAt` in
     `data/index.ts`, the `meta.fts_stale` read on the first pass and write
     on skip/clear, the idle-pass FTS-only branch, `reindex({ flushFts })`
     from the reindex route, the env pin in `vitest.config.ts`. Fitness
     test 3.
   - **C3 Codex walk reuse (simple).** `listRollouts()` remembers its last
     result; `getCodexContext()` uses it. Fitness test 2.
2. **Wave 2** — **C4 Web list paging (complex)**, after C1: `client.ts`
   gains `limit`/`offset` and reads the total header; `SessionList.tsx` gets
   the page state, "Load more", the count line, debounced server-side `q`,
   and the windowed data-version refetch. Verified against fixtures with the
   `verify` skill (load more, filter across pages, live row update).
3. **Wave 3** — README (env table row, search staleness note), CLAUDE.md
   gotchas (paging tie-break, FTS debounce and the persisted flag, Codex walk
   reuse), this plan's status, `/review`, `npm test`, `npm run typecheck`,
   markdownlint.

## Fitness functions

1. **Paging is stable.** For every sort key, pages of 2 over a fixture with
   tied sort values cover the unpaged set exactly once; `X-Total-Count`
   equals the unpaged count; `q` finds a session by branch, by id, and by
   model; an absent `limit` never returns more than the default.
2. **One walk per pass.** After `discover()`, preparing N subagent rollouts
   triggers no further `readdirSync` of the sessions dir; the parent map
   still resolves a grandchild to its root.
3. **Debounce never loses a rebuild.** Within the window, a second change
   leaves `sessions` fresh, FTS stale, and `meta.fts_stale` set; the next
   idle pass rebuilds FTS and clears the flag; a simulated restart with the
   flag set rebuilds on its first idle pass; `POST /api/reindex` flushes
   immediately; with the interval at 0 every pass rebuilds (the existing
   suite).

## Files affected

- `packages/shared/src/api.ts` — `offset`, the total-count header constant,
  `q` doc.
- `packages/server/src/routes/sessions.ts` — clamp, offset, tie-break,
  widened `q`, header.
- `packages/server/src/agent/api-client.ts`, `agent/query.ts`, `agent/mcp.ts`,
  `cli.ts` — `offset` through the CLI and MCP.
- `packages/server/src/data/index.ts`, `routes/index.ts` — FTS debounce,
  persisted flag, flush on manual reindex.
- `packages/server/src/connectors/codex/normalize.ts` — walk reuse.
- `packages/web/src/api/client.ts`, `pages/browse/SessionList.tsx` — paging
  UI.
- `vitest.config.ts` — pin `FTS_REBUILD_MIN_INTERVAL_MS=0`.
- `packages/server/test/sessions-pagination.integration.test.ts`,
  `fts-debounce.integration.test.ts`, an addition to
  `codex.integration.test.ts` — the fitness functions.
- `README.md`, `CLAUDE.md`, `docs/plans/README.md` — docs and the index row.

## Testing

`npm test` and `npm run typecheck` green (final: 81 files / 833 tests, up
from 78 / 807); each new test was run against the pre-fix code and failed
there first — the paging walk additionally fails with only the `, id`
tie-break reverted (36 distinct ids out of 52 rows), and the debounce test
fails with only the `meta` write removed. markdownlint clean on changed
docs. The `verify` skill drove the built app against 63 fixture sessions:
"Showing 50 of 63", Load more to 63 unique rows, a branch filter finding
three sessions that were never on page one, the empty state, and a session
dropped in live updating the loaded window without a reload. Not done: a
timing check against the live daemon, which runs the released build.

## Risks / open questions

- Ranked search lags up to `FTS_REBUILD_MIN_INTERVAL_MS` during continuous
  activity. Set it to `0` to restore per-pass rebuilds.
- `q` widening changes CLI/MCP results only by adding matches.
- A session landing live re-fetches the same-size window, so the last row of
  the window drops out and the count line flips from "Y sessions" back to
  "Showing …" with Load more; the list never grows on its own.
- A manual reindex arriving during a pass now waits for it and runs its own
  pass rather than joining one that may have skipped the rebuild.
- Page size, default cap, and the 60 s window are defaults chosen here;
  all three are one-line changes.
- Still deferred: a second DuckDB connection for the indexer (the
  shared-connection topic excluded from 0086) and sessions-list virtualization
  if lists ever exceed a few thousand rows.
