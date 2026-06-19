# 0027 — Session-efficiency analytics (per-session ratios table)

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-18
- **PR:** #38

## Context

Analytics today (0018) aggregates tokens/cost by `project | model | day | agent`
and charts trends + a breakdown bar chart. It never groups by **session**, so
there is no way to compare individual sessions or ask "which of my sessions were
*efficient*?". The session list (Browse) can sort by tokens/cost/messages, but
it is per-project-scoped, not date-range aware, and shows raw totals — not
ratios, and not a cross-project comparison.

This is the one genuinely-missing slice of the "session/productivity" theme (P3):
**per-session efficiency ratios**, presented as a comparative, sortable table.
(The other P3 ideas — time trends, export/share — already ship.)

Threat model unchanged: local, single-user, read-only viewer on `127.0.0.1`.

## Goal

A new **"Session efficiency"** view on the Analytics page: a date-range-aware,
sortable Top-N table of sessions, each row showing four efficiency ratios against
a median baseline, every row deep-linking to its session. Done = the table
renders real per-session ratios consistent with the rest of cost analytics
(same `usage_canonical` dedup, same cache-hit formula), with a median summary and
graceful handling of degenerate sessions.

## Decisions

- **Dedicated endpoint, not `groupBy: 'session'`.** A new
  `GET /api/analytics/sessions` returning a `SessionEfficiencyRow[]`, rather than
  overloading `/api/analytics`. Rejected extending `AnalyticsGroupBy` because
  `AnalyticsRow` carries no session identity (title/project/link), no
  `toolCallCount`, no duration, and no ratios — and the existing breakdown renders
  as a **bar chart**, not a table. A session table is a different UI and a
  different row shape; a clean endpoint avoids polluting the shared type.
- **Reuse the existing aggregation semantics exactly.** The query mirrors
  `routes/analytics.ts`: filter `e.type = 'assistant'`, sum on `usage_canonical`
  (so fork-copied / multi-block usage counts once), and reuse the 3-term cache-hit
  helper `cache_read / (cache_read + cache_write + input)`. Grouping is
  `GROUP BY e.session_id`, joined to `sessions` for identity. This keeps the new
  numbers consistent with every other cost/cache figure in the app.
- **Denominator `D` = deduped assistant responses.** The four ratios:
  - **Cache-hit %** = `cache_read / (cache_read + cache_write + input)`
  - **Cost / response** = `cost_usd / D`
  - **Tokens / response** = `total_tokens / D`
  - **Tool calls / response** = `tool_call_count / D`
  `D` is exactly the analytics "messageCount" (assistant `usage_canonical` rows),
  the correct per-turn denominator — counting all records (user + tool-result
  lines) would understate cost/response.
- **Date filter = session *start* in `[from,to]`, not per-event windowing.** The
  charts window events by `ts`; a session straddling a boundary getting
  half-counted would be wrong for whole-session ratios. A session is atomic here →
  filter on `startedAt`.
- **Compute as much as possible; skip what's empty — generically.** Ratios are
  computed for every session from whatever assistant data is indexed. A session
  needs **≥1 assistant response** for its ratios to be defined; a session with
  none (event-sourced Junie sessions with no model turns, a crashed session with
  no usage) has nothing to compute and is simply excluded. No agent-specific
  carve-out and no agent-named UI text.
- **`minResponses` control, default 1, clamped to ≥1.** Defaults to "show
  everything computable" and can be dialed *up* to suppress low-signal sessions
  whose ratios are noisy (e.g. a 1-response session where cost/response = the whole
  session). Applied before both the rows and the median. Because the floor is never
  below 1, every returned row has `D ≥ 1`, so the per-response ratio fields are
  always plain numbers (no nulls); cache-hit uses the existing helper, which
  returns `0` on an empty cache denominator.
- **Median over the full filtered set.** Computed via DuckDB `median()` across all
  qualifying sessions (post `minResponses`), then Top-N rows are returned — so the
  baseline reflects all your sessions, not just the visible page.
- **Full sortable grid layout.** Every metric is its own sortable column
  (responses, cost, tokens, tools, duration + the 4 ratios); the median is a footer
  row. Chosen over a compact ratios-forward layout for at-a-glance comparison.
- **A top-level view switch on the Analytics page.** `Overview` (existing
  trends + breakdown) | `Session efficiency` (the table). Date range is shared;
  the group-by toggle stays bound to Overview. The table is full-width and does
  not pair with the group-by control, so a switch is cleaner than a third panel.
- **Server-side sort + Top-N (`limit` default 50).** Because Top-N is server-side,
  a header click re-queries with the new `sort`. Deterministic tiebreak
  (`startedAt`, then `sessionId`) so the page is stable across reindexes.

## Approach

1. **Shared contract** (`packages/shared/src/api.ts`): add
   `SessionEfficiencySort`, `SessionEfficiencyQuery`, `SessionEfficiencyRow`, and
   `SessionEfficiencyResponse` (rows + `summary { sessionCount, median }`).
2. **Server route** (`packages/server/src/routes/analytics.ts`, or a sibling
   `analytics-sessions.ts` registered alongside): implement
   `GET /api/analytics/sessions`. One aggregation CTE over `events`
   (`type='assistant'`, `usage_canonical`) `GROUP BY session_id`, joined to
   `sessions` for `title/title_derived/project_cwd/connector_id/started_at/
   ended_at`; project id via `projectIdFromCwd`. Apply `startedAt` range +
   `minResponses` filter (clamped ≥1). Compute ratios in the TS map (reusing
   `cacheHitRatio`); rows have `D ≥ 1` by the floor, so per-response ratios are
   always defined, and cache-hit is `0` on an empty cache denominator. Compute
   medians in SQL over the filtered set. `ORDER BY <sort>` + tiebreak, `LIMIT`.
3. **Web API client** (`packages/web/src/api/client.ts`): add
   `getSessionEfficiency(query)`.
4. **Web UI** (`packages/web/src/pages/analytics/`):
   - Add the `Overview | Session efficiency` view switch to `AnalyticsPage.tsx`,
     sharing the existing date-range state.
   - New `SessionEfficiencyTable.tsx`: sortable column headers (drive the `sort`
     param), median footer row, a `minResponses` input, rows link to
     `/sessions/:id`. Reuse existing `format.ts` token/cost formatting and the
     `AgentBadge`.
   - Styling in `analytics.css`, matching existing analytics components.
5. **Tests** (`packages/server/test/`): extend the synthetic-fixture DuckDB suite.

## Files affected

- `packages/shared/src/api.ts` — new query/row/response types.
- `packages/server/src/routes/analytics.ts` (or new `analytics-sessions.ts`) —
  the `/api/analytics/sessions` handler; factor out the shared cache-hit helper if
  it moves.
- `packages/server/src/routes/index.ts` — register the route if it's a new module.
- `packages/web/src/api/client.ts` — `getSessionEfficiency`.
- `packages/web/src/pages/analytics/AnalyticsPage.tsx` — view switch + wiring.
- `packages/web/src/pages/analytics/SessionEfficiencyTable.tsx` — new component.
- `packages/web/src/pages/analytics/analytics.css` — table styles.
- `packages/server/test/*` — new fixture + cases (see Testing).

## Testing

Per repo convention — the bug-prone edges, not happy-path glue:

- **Degenerate sessions excluded:** a session with no assistant rows (`D = 0`,
  e.g. event-sourced Junie) is absent from rows and median (floor ≥1); no
  `NaN`/`Infinity` in the response body. A cache-heavy session with no fresh input
  reports cache-hit near 100%; one with no cacheable input reports `0`.
- **Dedup invariant:** a session whose usage rows are fork-copied / multi-block →
  `responses` and `costUsd` count once (`usage_canonical`), matching the existing
  cost-dedup guard.
- **Median over the full filtered set**, not just the returned Top-N; and
  `minResponses` excludes sub-floor sessions from both the median and the rows.
- **Date filter by `startedAt`:** a session started just outside `[from,to]` is
  excluded; one inside is included — no partial-event-window counting.
- **Sort + limit:** server-side `ORDER BY` per sort key returns the correct Top-N
  with a deterministic tiebreak.
- Fixture: a small set with one cache-heavy, one cache-poor, and one sub-floor
  (1-response) session, plus a degenerate session with no assistant rows (asserted
  absent).
- `npm run typecheck && npm test` green; manual check of the built app
  (`npm start`): the view switch, sorting, median row, and row deep-links work.

## Risks / open questions

- **Duration is wall-clock** (`endedAt − startedAt`) and inflated by idle gaps; it
  is a grounding column, not a ratio, so v1 displays it as-is with no idle-gap
  correction.
- **Cross-agent comparability.** Ratios are computed identically across agents,
  but agents differ in how they record usage (e.g. Copilot's session-level tokens
  land on the last assistant row; pi/opencode fold reasoning into output). The
  numbers are internally consistent per agent; cross-agent ratio comparisons
  should be read with that in mind. Not blocking — the table is descriptive.
- **Where the route lives** — fold into `routes/analytics.ts` vs a sibling module.
  Resolve during implementation based on file size; the route logic is cohesive
  with the existing analytics query.

## Post-review redesign (after first UI cut)

The first implementation shipped a generic ratios table that a design review
rejected (right-padded/unreadable, median buried in a footer, off-brand, unclear
value). The view was redesigned (mock-driven, approved before rebuild). What
actually shipped on PR #38:

- **Framing.** A cost-efficiency lens: the table is ranked by **cost** (the
  magnitude), with efficiency ratios as context. A summary line above carries the
  baseline (sessions, total spend) plus a spend-concentration insight (top-3 cost
  share, server-provided as `summary.top3CostUsd`).
- **Columns.** `Session · Resp · Cost · $/resp · Tools · Tools/resp · Cache`.
  **Cache** is gated behind the existing **"Show cache"** toggle (default hidden),
  consistent with the rest of Analytics. `tokensPerResponse` and `duration` were
  dropped from the UI (the row type still carries them).
- **On-brand.** Reuses the app idiom — `<AgentBadge>` (real per-agent colors),
  cost/`formatCost`/`formatPct` helpers, card shell, tabular numerics. Numeric
  alignment is set **only** via `.tv-eff__num` (never a blanket `td` rule), so the
  left-aligned session column needs no competing override — the original
  right-alignment bug was a specificity collision.
- **Median row pinned at the TOP** (not a footer) as the "typical" reference.
- **Uniform IQR / Tukey outlier flags.** A cell is flagged (accent + ▲ high / ▼
  low) only when its value clears `q1 − 1.5·IQR` / `q3 + 1.5·IQR`, computed per
  column over the full filtered set. Identical treatment for cache-hit, $/resp,
  and tools/resp — no per-column color or good/bad judgment, no median-split.
- **API change.** `summary` now returns `sessionCount`, `totalCostUsd`,
  `top3CostUsd`, and per-column `{ median, q1, q3 }` (`SessionEfficiencyStat`, via
  DuckDB `quantile_cont`) so the IQR fences stay consistent with the server-side
  Top-N. The earlier `summary.median` shape is replaced.
- **Dropped** the `minResponses` UI control (server still defaults to 1).
- **Verified** against the running app (synthetic-data screenshots): alignment,
  median row, sort headers, agent colors, Show-cache gating.
