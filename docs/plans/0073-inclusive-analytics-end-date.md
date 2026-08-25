# 0073 — Inclusive analytics end date

- **Status:** done
- **Date:** 2026-08-25
- **PR:** https://github.com/vladar107/claudescope/pull/95

## Context

Issue #94 reports that date-only `to` bounds exclude nearly all activity on the
named day. DuckDB casts `YYYY-MM-DD` to midnight, while the shared analytics
scope currently compares timestamps with `<=`. The public CLI and MCP contract
describes the bound as inclusive.

Analytics timestamps are stored as UTC-naive DuckDB `TIMESTAMP` values. This fix
preserves the current UTC calendar-day meaning for date-only CLI/MCP bounds;
making analytics consistently timezone-aware remains a separate follow-up.

## Goal

Make a date-only `to` bound include the entire named UTC day without changing
the inclusive semantics of full timestamp bounds or the existing `from` bound.

## Decisions

- **Use a half-open next-midnight comparison for date-only upper bounds** —
  `< date + INTERVAL 1 DAY` includes every representable timestamp on the day
  without relying on an end-of-day fractional precision.
- **Keep full timestamps inclusive with `<=`** — callers that provide an exact
  instant, including the web UI's local-day-to-UTC conversion, keep their
  existing contract.
- **Do not add implicit local-time interpretation** — the daemon timezone is not
  a stable API contract; filtering and day grouping need one explicit timezone
  in a future, separately scoped change.

## Approach

1. Update the shared analytics scope filter to distinguish date-only upper
   bounds from full ISO timestamps after validation.
2. Extend the existing query-parameter integration suite to cover same-day
   analytics, date-only digest ranges, and exact timestamp inclusivity.
3. Run focused and full validation, then review the complete diff.

## Files affected

- `packages/server/src/data/analytics-scope.ts` — implement the date-only upper
  bound semantics.
- `packages/server/test/query-params.integration.test.ts` — add regression
  coverage at the shared HTTP boundary.
- `CLAUDE.md` — retain the explicit timezone-aware analytics follow-up.
- `docs/plans/0073-inclusive-analytics-end-date.md` — record the implementation
  decisions and verification.
- `docs/plans/README.md` — index this plan.

## Testing

- `npm test -- packages/server/test/query-params.integration.test.ts`
- `npm test`
- `npm run typecheck`
- `git diff --check`
- Review the final diff for range regressions and unrelated changes.

## Risks / open questions

- Date-only CLI/MCP ranges remain UTC calendar days. Fully timezone-aware range
  filtering and day grouping are a required follow-up, not part of issue #94.
- The shared helper serves eight analytics endpoints, so the regression tests
  must prove both event-timestamp and session-start consumers retain their
  intended scope.
