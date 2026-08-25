# 0074 — Timezone-aware analytics

- **Status:** done
- **Date:** 2026-08-25
- **PR:** https://github.com/vladar107/claudescope/pull/96

## Context

Analytics timestamps are normalized as UTC instants by the connectors, then
stored in the derived DuckDB index as timezone-naive `TIMESTAMP` values. Date
filters and calendar grouping do not currently share one timezone contract:
the web converts date inputs using the browser timezone, day grouping stays in
UTC, CLI/MCP date-only ranges mean UTC days, and the activity heatmap applies a
single fixed offset that is incorrect across daylight-saving transitions.

DuckDB's bundled ICU support can interpret IANA timezone names and convert the
stored UTC-naive values at query time. The index remains fully rebuildable, so
changing its timestamp types would add migration cost without improving the
source-of-truth representation.

## Goal

Make every analytics date boundary and calendar grouping use one explicit IANA
timezone, including correct daylight-saving behavior, while preserving UTC as
the compatibility default for raw API callers.

## Decisions

- **Keep UTC-naive storage** — connectors already normalize source timestamps to
  UTC and the derived index consistently treats them as UTC; query-time
  conversion avoids a schema bump and full rebuild.
- **Add an explicit `timeZone` query parameter** — first-party clients send an
  IANA zone, while an omitted parameter means UTC so bare HTTP callers retain
  deterministic behavior.
- **Interpret date-only bounds as calendar days in `timeZone`** — the lower
  bound is local midnight and the upper bound remains half-open at the next
  local midnight, so 23-hour and 25-hour DST days are handled correctly.
- **Treat offset-bearing timestamps as absolute instants** — `Z` and numeric
  offsets are preserved through `TIMESTAMPTZ` parsing instead of being discarded
  by a naive timestamp cast.
- **Use the same timezone for grouping and filtering** — day analytics, impact,
  activity heatmaps and streaks, and digest defaults cannot disagree about which
  calendar day contains an event.
- **Retain `tzOffsetMinutes` as an activity fallback** — existing callers keep
  working when `timeZone` is absent; the web moves to the IANA contract.

## Approach

1. Add shared timezone validation and SQL expressions that reinterpret stored
   UTC-naive timestamps as instants, convert instants to local calendar values,
   and build date-only bounds in an IANA zone.
2. Extend all analytics route query shapes with `timeZone`, route every bound
   through the shared scope helper, and localize day grouping, activity, streak,
   impact, and digest calculations.
3. Have the web send its browser IANA timezone and the original date-only input
   values to every analytics endpoint.
4. Add CLI `--timezone` support plus MCP timezone input; first-party agent
   clients detect the machine IANA timezone when no override is supplied.
5. Add focused integration coverage for DST boundaries, date-only ranges,
   offset-bearing instants, invalid zones, and the legacy activity fallback.
6. Run focused tests, the full test suite, typecheck, build, diff checks, and a
   final code review before opening the PR.

## Files affected

- `packages/server/src/params.ts` — validate timezone query parameters.
- `packages/server/src/data/analytics-scope.ts` — centralize timezone-aware
  bounds and timestamp conversion expressions.
- `packages/server/src/routes/analytics*.ts` — accept and consistently apply the
  timezone contract across filters and calendar groupings.
- `packages/shared/src/api.ts` — expose the timezone in analytics request types.
- `packages/web/src/api/client.ts` — forward the timezone on analytics requests.
- `packages/web/src/pages/analytics/AnalyticsPage.tsx` — detect the browser IANA
  zone and send date-only bounds without pre-converting them to UTC instants.
- `packages/server/src/agent/{api-client,query,mcp}.ts` and
  `packages/server/src/cli.ts` — expose CLI/MCP timezone controls.
- `packages/server/test/*analytics*.test.ts` — cover timezone and DST edges.
- `README.md` — document date and timezone semantics for agent-facing commands.
- `docs/plans/README.md` — index this plan.

## Testing

- Focused analytics integration tests covering spring-forward and fall-back
  calendar boundaries in `Europe/Amsterdam`.
- Full timestamps with `Z` and numeric offsets resolve to the same instant.
- Invalid IANA zones return HTTP 400 without exposing DuckDB internals.
- Existing UTC/default and `tzOffsetMinutes` behavior remains compatible.
- `npm test`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

## Risks / open questions

- A raw HTTP request carries no browser timezone. The server therefore keeps a
  deterministic UTC default instead of silently using its process timezone;
  first-party clients send their detected IANA zone explicitly.
- IANA timezone data changes occasionally; validation and conversion must use
  the same runtime database DuckDB uses for query execution.
- DST gaps and overlaps make local wall-clock timestamps ambiguous, but the
  stored values are UTC instants; ambiguity exists only for caller-supplied
  local date boundaries, where midnight is well-defined for normal IANA zones.
