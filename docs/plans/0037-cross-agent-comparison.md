# 0037 — Cross-agent comparison analytics

- **Status:** done
- **Date:** 2026-07-03
- **PR:** [#49](https://github.com/vladar107/claudescope/pull/49)

## Context

Slice B1 of the [0035 roadmap](./0035-agent-access-and-analytics-roadmap.md).
The corpus is uniquely multi-agent, but the analytics page only breaks totals
down *by* agent — there is no head-to-head view answering "which agent do I
actually use on this project, and what does each cost me?". Everything needed
is already indexed (`events` + `sessions.connector_id`, `pr_links`,
`has_sidechain`); no schema change is required.

The core design constraint is honesty about data gaps: agents record usage at
different granularities, and a missing metric must read as "not available",
never as 0.

## Goal

A new `/api/analytics/agents` endpoint plus an "Agents" view on the analytics
page: one row per agent over the sessions in scope (optional project + date
range) with n/a-aware metrics, and two ride-along stats (PR-linked session
cost, subagent-usage share) that were already indexed but unused.

## Decisions

- **Usage granularity is declared per connector, not inferred from data** —
  `USAGE_GRANULARITY` in the route maps each connector to
  `per-response | session-level | none`; a zero-usage corpus is still a real 0
  for a per-response agent. Verified against the connectors: claude-code,
  codex, pi, opencode AND junie record per-response usage (junie parses
  `LlmResponseMetadataEvent.modelUsage` per turn — the roadmap's "junie has no
  tokens" assumption was wrong); copilot is session-level (shutdown-only);
  antigravity has none.
- **Null means "not available", never 0** — nullability is decided by the
  granularity map: `none` nulls all token/cost metrics; `session-level` keeps
  session totals real but nulls per-response ratios; the API ships a per-row
  `availabilityNote` so the UI tooltip can say *why*.
- **Date bounds filter on session START** (like `/api/analytics/sessions`) —
  sessions are atomic here; per-event windowing would half-count a session
  straddling the boundary. This also sidesteps Copilot's tokens-on-last-row
  smearing.
- **Aggregation semantics match `/api/analytics`** — assistant events,
  `usage_canonical` dedup, the shared cache-hit denominator; grouped by the
  session's connector via the `sessions` join.
- **PR ride-along uses `sessions.total_cost_usd`** — already deduped at
  derivation time; only Claude Code emits pr-link records, so the stat is
  labeled Claude-Code-only.
- **No new chart** — a comparison table (rows = agents) reusing the
  session-efficiency table styles; the row count is the number of agents, so
  client-side rendering with no server sorting is enough.

## Approach

1. Shared types: `AgentUsageGranularity`, `AgentComparisonRow`,
   `PrLinkedStats`, `AgentComparisonResponse` in `packages/shared/src/api.ts`.
2. New route `packages/server/src/routes/analytics-agents.ts`
   (`GET /api/analytics/agents?project=&from=&to=`), registered in
   `routes/index.ts`. Project filter resolves the slug id against
   `project_cwd` exactly like `/api/sessions`.
3. Web: `api.analyticsAgents()` client method; `AgentComparisonTable.tsx`;
   an `agents` view in `AnalyticsPage.tsx` with a project `<select>` (fed from
   the already-loaded projects map) + the existing date-range filter; PR
   ride-along as a stat card; subagent share as a table column.
4. Integration test `agent-comparison.integration.test.ts`: fixtures for the
   three granularity classes (Claude Code, Copilot incl. a crashed session,
   Antigravity) asserting null-not-zero through the route, split dedup,
   PR stats, and the project/date filters.

## Files affected

- `packages/shared/src/api.ts` — comparison types.
- `packages/server/src/routes/analytics-agents.ts` — new route (new file).
- `packages/server/src/routes/index.ts` — registration.
- `packages/web/src/api/client.ts` — `analyticsAgents`.
- `packages/web/src/pages/analytics/AgentComparisonTable.tsx` — new component.
- `packages/web/src/pages/analytics/AnalyticsPage.tsx` — `agents` view + project select.
- `packages/web/src/pages/analytics/analytics.css` — `__select` + `.tv-na` styles.
- `packages/server/test/agent-comparison.integration.test.ts` — new test (new file).

## Update (2026-07-03, same PR)

The standalone **Errors** tab (plan 0041) was folded into this comparison view
before merge: `/api/analytics/agents` now joins `errorSignalsByAgent` (shared
with the digest) and the table gained `Err rate` / `Interrupts` columns with
per-column n/a tooltips. `ErrorsTable.tsx` and the web client's
`analyticsErrors` call were removed; the `/api/analytics/errors` route stays
(scripting surface + digest reuse).

## Testing

`npm test` (318 passing, incl. the 7 new integration tests) and
`npm run typecheck`. The new suite builds a real DuckDB index from synthetic
Claude Code + Copilot + Antigravity fixtures in a temp dir and exercises the
route through Fastify `.inject()`.

## Risks / open questions

- Junie sessions predating usage recording fold real zeros into the sums —
  acceptable (it is genuinely recorded-as-zero data, not a format gap).
- Copilot cache-hit ratio comes from whatever the shutdown record carries;
  kept non-null with the session-level caveat in the tooltip.
- `subagentShare` is null for Junie (delegation via plain terminal commands is
  invisible by design) — static rule, not fixture-tested.
