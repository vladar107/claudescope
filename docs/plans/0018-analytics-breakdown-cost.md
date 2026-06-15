# 0018 — Analytics breakdown by cost (Metric + Sort toggles)

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-15
- **PR:** https://github.com/vladar107/claudescope/pull/21

## Context

The Analytics → *Breakdown* chart (per project / agent / model / day) only ever
spoke in tokens: bars were stacked input/output/cache token segments, sorted by
the visible token sum, with cost relegated to the tooltip. There was no way to
see — or order — the breakdown by spend, even though cost is a first-class
column in the analytics rows (`costUsd`). Users comparing projects by money had
to read the tooltip row by row.

## Goal

Let the breakdown chart render and order by **cost** as well as tokens, without
changing the default (tokens) behavior.

## Decisions

- **Two independent controls (Metric + Sort), not one.** Per product call, keep
  them orthogonal so any of the four combinations is reachable: bars in tokens
  but ordered by cost (to spot "lots of tokens, little spend"), or a pure cost
  view. A single "sort by cost" toggle that re-ordered token bars was rejected
  as visually incoherent on its own; a metric switch makes cost mode coherent.
- **Cost mode = single bar, dollar axis.** In cost mode the stacked token
  segments collapse to one `cost` bar (gold, matching the cost accent) and the
  x-axis formats as `$`. The tooltip still shows the full token + cost breakdown
  in every mode.
- **Sibling `{cond && <Bar/>}` conditionals, not a `<>`-wrapped group.** Recharts
  resolves chart children by component type; fragment flattening is
  version-sensitive, and the rest of the codebase uses bare conditional siblings.
  Matching that pattern avoids a silent "bars don't render" trap.
- **Controls live in the chart-card header, not the page toolbar.** They only
  affect the breakdown chart (the time series always shows both), so they belong
  next to it. `ChartCard` grew an optional `actions` slot for this.
- **Defaults unchanged** (`metric=tokens`, `sortBy=tokens`) so existing behavior
  and the README screenshot are preserved.

## Approach

1. `BreakdownChart` — add `metric` / `sortBy` props; switch the sort comparator
   (cost vs visible tokens) and the rendered bars (single cost bar vs stacked
   token segments); make the x-axis formatter follow the metric.
2. `AnalyticsPage` — add `metric` / `sortBy` state, a reusable `SegmentedControl`,
   wire two controls into the breakdown card via a new `ChartCard` `actions` slot,
   and make the card hint reflect the active sort.
3. `analytics.css` — header layout for title/hint + right-aligned actions; a
   compact `tv-segmented--sm` variant matching the existing segmented toggle.

## Files affected

- `packages/web/src/pages/analytics/BreakdownChart.tsx` — `metric`/`sortBy`
  props, cost bar + dollar axis, sort comparator.
- `packages/web/src/pages/analytics/AnalyticsPage.tsx` — state, `SegmentedControl`,
  `ChartCard.actions`, dynamic hint.
- `packages/web/src/pages/analytics/analytics.css` — header/actions layout,
  `tv-segmented--sm`.

## Testing

- `npm run typecheck`, full `npm run build`, `npm test` (169 passing) — all green.
- Manual (headless Chromium against synthetic demo data, isolated
  `CLAUDESCOPE_HOME` — real `~/.claude` untouched): screenshotted all three
  states. Confirmed tokens/sort-tokens unchanged; tokens/sort-cost reorders rows
  while keeping token-sized bars; cost/sort-cost renders dollar-sized bars on a
  `$` axis in descending order. Verified the active-state highlight and the
  hint flip between "top 15 by tokens" / "top 15 by cost".

## Risks / open questions

- Pure UI change; no API, contract, or index changes, so nothing to add to the
  integration suite.
- With `metric=cost`, the global "Show cache" toggle no longer affects the
  breakdown bars (cost is a single value); it still drives the time series and
  summary card, so it's left enabled rather than contextually hidden.
