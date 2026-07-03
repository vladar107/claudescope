# 0043 — Retire the Activity tab: redistribute its pieces

- **Status:** done
- **Date:** 2026-07-03
- **PR:** [#54](https://github.com/vladar107/claudescope/pull/54)

## Context

After the 0035 roadmap landed, the analytics nav read Overview · Efficiency ·
Activity · Digest. User feedback: Activity "looks strange and useless." The
diagnosis — the tab bundled three things of very different value, and its one
unique element was the weakest: the day-of-week × hour punchcard is a vanity
viz (it tells you when you work, which you already know, and renders sparsely).
The genuinely useful pieces belonged elsewhere: the tool-usage breakdown is a
*how agents work* diagnostic (a natural neighbor of the error rates in the
Agents scorecard), and the streak is a fun stat stuck in the wrong place.

## Goal

Three tabs, no filler: **Overview · Efficiency · Digest**. Nothing useful lost.

## Decisions

- **Punchcard deleted, not redesigned** — Overview's per-day time series covers
  "how much, when" at the honest resolution. If a temporal view earns its way
  back, a GitHub-style contribution calendar in Overview is the noted follow-up.
- **Tool-usage chart → Efficiency (Agents grain)**, below the comparison table,
  where it pairs with tool-error rates. It now honors the tab's project scope:
  `/api/analytics/tools` gained `project=` via the shared `scopeFilters` helper
  (date bounds intentionally stay on the event timestamp).
- **Streak → Overview stat card** (🔥 current / longest), fed by the existing
  `/api/analytics/activity` response; the fetch is now overview-only.
- **`/api/analytics/activity` route kept** — it feeds the streak card (and the
  digest reuses `computeStreaks`). Its now-unused heatmap payload is a candidate
  for slimming later; not worth an API break today.

## Files affected

- `packages/web/src/pages/analytics/AnalyticsPage.tsx` — view union, buttons,
  effects (activity → overview-only; tools → agents-grain + project scope),
  streak card in `SummaryCards`, tool chart into the agents grain.
- `packages/web/src/pages/analytics/ActivityHeatmap.tsx` — deleted (+ its CSS).
- `packages/server/src/routes/analytics-tools.ts` — `project=` param.
- `packages/web/src/api/client.ts` — `analyticsTools` project param.
- `packages/server/test/analytics-tools.integration.test.ts` — project-scope
  test (matching slug = all rows; bogus slug = none).

## Testing

`npm test` 374/374, `npm run typecheck` clean. Manual: Overview shows the
streak card; Efficiency → Agents shows the tool-usage chart scoped by the
project selector; no Activity button remains.

## Risks / open questions

- Contribution-calendar follow-up (Overview) if a temporal view is missed.
- `/api/analytics/activity` heatmap payload now has no web consumer.
