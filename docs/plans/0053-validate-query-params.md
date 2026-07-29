# 0053 — Validate query params before they reach SQL

- **Status:** in-progress <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-29
- **PR:** https://github.com/vladar107/claudescope/pull/73

## Context

Second PR from the repo-wide review (after [0052](./0052-indexer-durability-and-state-perms.md)).
Three query-param paths reach SQL without validation and 500 with the generated
statement in the response body. All reproduced against a real index.

**1. The sort allowlist is bypassed by the prototype chain.** Both sort gates
test membership with `in`, which walks `Object.prototype`:

```text
GET /api/sessions?sort=toString
→ 500  Parser Error: syntax error at or near "toString"
   LINE 1: SELECT * FROM sessions ORDER BY function toString() { [native code] }

GET /api/analytics/sessions?sort=constructor
→ 500  ORDER BY function Object() { [native code] } DESC NULLS LAST…
```

Not injection — the value is a `Function`, not attacker-controlled text — but it
defeats the allowlist `analytics-sessions.ts` documents as *"Never interpolate
the raw param"*, and `?sort=__proto__` yields `ORDER BY [object Object]`.

**2. Date bounds are interpolated unvalidated.** `sqlString` blocks injection but
not a cast error:

```text
GET /api/analytics?from=not-a-date
→ 500  Conversion Error: invalid timestamp field format: "not-a-date"
   LINE 10: WHERE e.type = 'assistant' AND e.ts >= 'not-a-date'::TIMESTAMP
```

There are five `::TIMESTAMP` interpolation sites but **eight** affected
endpoints, because `scopeFilters` is shared: `/api/analytics`,
`/analytics/sessions`, `/analytics/agents`, `/analytics/activity`,
`/analytics/tools`, `/analytics/impact`, `/analytics/errors`,
`/analytics/digest`. The MCP `get_analytics` tool passes `from`/`to` straight
through, so agents hit it too.

This is also the duplication finding: the same two-line bound filter is written
five times, which is *why* the validation gap is 5× instead of 1×. Notably
`analytics-activity.ts` already regex-validates its `today` param — the
discipline exists, it just was not applied to `from`/`to`.

**3. 500 responses echo the SQL.** Fastify's default error handler serializes
`err.message`, so a DuckDB parser/conversion error ships the generated statement
(table and column names included) to the client. Low impact on a loopback-only
viewer, but it is free to stop leaking.

Ride-along: the CSP has no `form-action`. Unlike the fetch directives it does
**not** inherit from `default-src`, so it is genuinely unrestricted.

## Goal

No query param can reach SQL unvalidated; a bad one returns 400 with a useful
message instead of 500 with a statement dump. The five duplicated bound filters
become one.

## Decisions

- **Validate inside `scopeFilters`, not per route** — it is the shared chokepoint,
  so every current and future caller is covered by construction. Routes that
  hand-rolled their own bound filters move onto it, which fixes the duplication
  and the validation gap in one change.
- **Invalid date → 400; unknown sort → silent fallback** — deliberately
  asymmetric. An unparseable date is a caller mistake worth reporting, and today
  it is a 500 either way. An unknown `sort` already falls back to the default and
  real clients depend on that; `Object.hasOwn` closes the hole without changing
  behaviour for anyone.
- **A typed `BadRequestError` plus one `setErrorHandler`** — rather than each
  route branching on validity. The handler is registered in `routes/index.ts`
  (not `index.ts`'s `main`) so tests, which build a bare Fastify with
  `registerRoutes`, exercise the same behaviour as production.
- **Accept exactly what the callers send** — `YYYY-MM-DD` (the MCP/CLI contract)
  and full ISO with optional time/fraction/offset (what the web sends via
  `toISOString()`, and what the digest's own default range uses). Shape is
  checked by regex and reality by `Date.parse`, so `2026-13-45` is rejected
  rather than passed to DuckDB. `TIMESTAMP` (not `TIMESTAMPTZ`) semantics are
  unchanged — the cast already ignored the offset and this must not alter
  existing numbers.
- **Generic 500 body, full detail to the log** — `{error: 'Internal Server
  Error'}` to the client, `req.log.error` with the real error server-side, so
  debuggability is unaffected.

## Approach

1. New `src/params.ts`: `BadRequestError`, `timestampParam()`, `isoDayParam()`.
   Root-level so both `data/` and `routes/` may import it without inverting the
   existing layering.
2. `data/analytics-scope.ts`: validate `from`/`to` through `timestampParam`.
3. Move `/api/analytics`, `/analytics/activity`, `/analytics/tools` and
   `/analytics/digest` onto `scopeFilters` for their bounds, deleting the four
   hand-rolled copies.
4. `routes/sessions.ts` + `routes/analytics-sessions.ts`: `Object.hasOwn` gates.
5. `routes/index.ts`: `setErrorHandler` mapping `BadRequestError` → 400,
   preserving explicit 4xx, and collapsing everything else to a generic 500.
6. `security.ts`: add `form-action 'self'`.
7. Tests: prototype-chain sort keys, invalid dates on every affected endpoint,
   no SQL in a 500 body, and that valid formats still produce identical results.

## Files affected

- `packages/server/src/params.ts` — new; validators + `BadRequestError`.
- `packages/server/src/data/analytics-scope.ts` — validate bounds.
- `packages/server/src/routes/analytics.ts`, `analytics-activity.ts`,
  `analytics-tools.ts`, `analytics-digest.ts` — use `scopeFilters` for bounds.
- `packages/server/src/routes/sessions.ts`,
  `packages/server/src/routes/analytics-sessions.ts` — `Object.hasOwn`.
- `packages/server/src/routes/index.ts` — error handler.
- `packages/server/src/security.ts` — `form-action`.
- `packages/server/test/query-params.integration.test.ts` — new.

## Testing

- `npm test`, `npm run typecheck`, `npm run build`, markdownlint.
- New integration test covers each prototype key (`toString`, `constructor`,
  `__proto__`) on both sort routes, an invalid date on all eight endpoints, and
  asserts a 500 body carries no `SELECT`/table names.
- Regression check: the same requests must fail (500) with the fixes reverted.
- Equivalence check: `from`/`to` in both accepted formats return the same rows
  before and after the `scopeFilters` consolidation, so moving four routes onto
  the shared helper cannot silently change a bound.

## Risks / open questions

- Consolidating onto `scopeFilters` changes which column the bound applies to if
  a `ts` override is missed: `/api/analytics`, `/analytics/activity` and
  `/analytics/tools` filter the EVENT timestamp (`e.ts`), while the default is
  the session start (`started_at`). The equivalence test above is what guards it.
- `/api/analytics` gains no project filter — only the bounds move. Passing a
  `project` there stays ignored, as today.
- A 400 where clients previously got a 500 is a visible API change, but no client
  can be relying on the 500.
