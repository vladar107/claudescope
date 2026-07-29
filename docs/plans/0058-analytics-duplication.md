# 0058 — Consolidate the analytics duplication

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-29
- **PR:** <link, once opened>

## Context

Seventh and last cleanup PR from the repo-wide review. No behaviour change
intended; the point is that several derived values had more than one definition,
and one of those definitions was already wrong.

**1. The cache-hit ratio had three implementations.** Byte-identical TypeScript
functions in `routes/analytics.ts` and `routes/analytics-agents.ts`, plus the same
formula hand-written as SQL in `routes/analytics-sessions.ts`.

**And the documentation of it was wrong.** `analytics.ts`'s header said:

```text
cacheHitRatio = cache_read / (cache_read + input)
```

while its own code — and an inline comment 50 lines below — included
`cache_write`. Anyone trusting the header would compute a materially different
number: for a session that primed a large cache (`cache_read: 1`,
`cache_write: 999`) the documented formula gives **1.0** and the real one gives
**0.001**.

**2. Project-slug resolution had three copies.** `data/analytics-scope.ts` exists
specifically to centralise it — its own header says *"Centralised here so the
slug-resolution loop … can't drift between routes"* — yet `routes/sessions.ts` and
`routes/search.ts` each carried their own copy of the loop **and** of the
never-match sentinel `'\0'`.

**3. MCP and CLI duplicated two pieces of shaping.** The session-windowing
defaults (with a comment on one saying "Same defaulting as the MCP get_session
tool") and the analytics totals line, both while already importing from a shared
`agent/shape.ts`.

**4. `db/schema.ts`'s header listed a `projects` table** that does not exist in
the DDL.

## Goal

Each derived value has one definition. Where a second encoding is unavoidable, a
test proves the two agree.

## Decisions

- **Keep both cache-hit encodings, and test their agreement** — the SQL one
  cannot be replaced by the TS one: `/api/analytics/sessions` makes
  `cache_hit_ratio` a sortable column and feeds it to `quantile_cont` for the
  median/quartile summary, so it must exist inside the query. Rather than pretend
  one can go, the formula is stated once in prose with the two encodings beside it
  and a test evaluates the generated SQL in DuckDB against the TS function over
  ten cases (zero denominator, NULLs, a case that truncates under integer
  division, cache_write dominating). Same shape as the canonical-contract test in
  0055: two representations, one source, enforced.
- **Pin the new SQL against the expression it replaced** — the legacy hand-written
  CASE is kept in the test as a literal and asserted equal, so the consolidation
  provably changed no number.
- **Decompose the slug resolution rather than route everything through
  `scopeFilters`** — `/api/sessions` and `/api/search` have no date scope, so
  calling a function named "scope filters" for a project-only filter reads wrong.
  `resolveProjectCwd` and `projectFilter` are the pieces; `scopeFilters` now uses
  them too, so all three callers share one loop and one sentinel.
- **Do NOT cache `collectMemory`** — it was on the review list for re-reading
  every memory file plus scanning `sessions` on each call, including per search
  keystroke. Measured first, on a corpus matching the reviewer's shape (504
  sessions, 56 project dirs, 96 fact files): **3.4 ms median**. At ~3 calls/second
  while typing that is ~1% of one core. A TTL cache would trade that for staleness
  in a feature deliberately documented as read-live-never-indexed. Not worth it;
  recorded here so the next reader doesn't re-litigate it.

## Approach

1. `data/analytics-metrics.ts` — new; `cacheHitRatio` + `cacheHitRatioSql`, with
   the formula documented once.
2. `data/analytics-scope.ts` — add `resolveProjectCwd` / `projectFilter`, hoist
   the sentinel to `NEVER_MATCHES`, and have `scopeFilters` delegate.
3. `routes/{sessions,search}.ts` — use `projectFilter`.
4. `agent/shape.ts` — add `resolveWindowArgs` + `analyticsTotalsLine`; `mcp.ts`
   and `query.ts` use them.
5. Fix the wrong formula in `analytics.ts`'s header and the phantom table in
   `db/schema.ts`.

## Files affected

- `packages/server/src/data/analytics-metrics.ts` — new.
- `packages/server/src/data/analytics-scope.ts` — resolution helpers + sentinel.
- `packages/server/src/routes/{analytics,analytics-agents,analytics-sessions,sessions,search}.ts`
- `packages/server/src/agent/{shape,mcp,query}.ts`
- `packages/server/src/db/schema.ts` — doc only.
- `packages/server/test/analytics-metrics.test.ts` — new.

## Testing

- `npm test` (583 → 588), `npm run typecheck`, `npm run build`, markdownlint.
- The agreement test catches divergence from **either** side: dropping
  `cache_write` from the SQL fails 2 cases, and dropping it from the TS fails 2.
- Project filtering re-verified end to end through the existing API, query-param
  and analytics-tools integration suites (68 cases) — those already assert
  filtering by project id returns the right sessions.

## Risks / open questions

- `cacheHitRatioSql` takes column *expressions* as strings, so a caller could pass
  something unexpected. Every call site is a literal in this repo, and the values
  are column names rather than user input, but it is string-built SQL like the rest
  of the query layer.
- `projectFilter` runs a distinct-cwd scan per call, as all three copies did
  before. Unchanged, and cheap (one row per project) — noted only because the
  consolidation makes it easy to add a caller that calls it in a loop.
