# 0030 — Analyze tab: activity heatmap + tool-usage breakdown

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-29
- **PR:** https://github.com/vladar107/claudescope/pull/41

## Context

A comparison with [Code Insights](https://github.com/melagiri/code-insights) — a
local-first, multi-agent session analyzer — surfaced two analytical angles
Claudescope lacks. Code Insights' headline features (decision/learning
extraction, prompt-quality scoring, weekly synthesis, generated rules) all depend
on an LLM and cross Claudescope's identity: **deterministic, read-only, nothing
leaves the machine**. But two of its lighter ideas are a clean fit and need no
LLM:

- **"When do I work?"** — Code Insights' *activity charts*. Claudescope's `events.ts`
  is indexed but never bucketed by hour/day-of-week, and there is no streak notion.
- **"What do I do?"** — Code Insights' *multi-tool usage metrics*. Claudescope only
  stores a per-event `tool_use_count`; the tool *names* are discarded, so we can't
  break usage down by tool.

Claudescope's existing Session-Efficiency table (#0027) already covers the
deterministic equivalent of Code Insights' per-session metrics (turns, tool
calls, cost-per-response), so the only real gaps are these two.

Everything here is pure aggregation over the existing DuckDB index — no new
runtime dependency, no network, no LLM.

## Goal

Add two cards to the existing **Analyze** tab (`AnalyticsPage`): a GitHub-punchcard
**activity heatmap** (with current/longest streak), and a **tool-usage breakdown**
by normalized category. Both honor the page's existing date-range filter.

## Decisions

- **Activity unit = user prompts** (`events.type = 'user'`) — the best proxy for
  "when I'm actively driving an agent." Rejected: sessions-started (too coarse) and
  all-events (dominated by assistant/tool chatter, not *my* engagement).
- **Tool names stored as a list column on `events`, not a side `tool_calls` table.**
  Add `tool_names VARCHAR[]` to `events`, populated where `tool_use_count` is already
  computed. Keeps the one-row-per-event model, needs no join, and is fully
  rebuildable. A side table only pays off for per-tool tokens/latency — out of scope
  (YAGNI).
- **Normalized categories, mapping in code; raw names stored in the index.** The
  index keeps the (already-canonicalized) raw tool name; a pure
  `toolCategory(name)` in `packages/shared` maps to a fixed taxonomy
  (**Edit, Read, Search, Shell, Web, Subagent, Other**). The taxonomy can evolve
  without re-indexing, and raw names survive for tooltips ("Search = Grep + Glob").
- **Migration is a version bump.** Bump `SCHEMA_VERSION` 7 → 8 so the derived-cache
  rebuild path discards and re-indexes automatically. No in-place migration code.
- **Streaks are all-time** (current + longest, relative to today) and ignore the
  date filter — a "current streak" is only meaningful relative to now. The heatmap
  and tool bars *do* respect the filter.
- **Local-timezone bucketing.** An hour-of-day heatmap is meaningless in UTC. The
  client sends its IANA zone; the server buckets in local time. See Risks for the
  ICU detail.
- **Heatmap is a CSS-grid component, not Recharts.** Recharts has no native heatmap;
  a 7×24 grid of intensity-shaded cells is simpler and adds no dependency. The
  tool-usage bars reuse the existing `chart-common.tsx` styling.
- **Placement:** both cards land in `AnalyticsPage`'s existing vertical stack,
  after the token/cost time-series and before the project/model breakdown and the
  Session-Efficiency table — so the page reads *how much* → *when & what* → *where
  it goes*. No new tab.

## Approach

1. **Shared taxonomy** — add `ToolCategory` type + pure `toolCategory(name)` to
   `packages/shared`. Default → `Other`. Cover the canonical names Claudescope
   already normalizes (`Edit`/`Write`/`MultiEdit` → Edit, `Read` → Read, `Bash` →
   Shell) plus the common agent-specific ones (`Grep`/`Glob`/`Search` → Search,
   `WebFetch`/`WebSearch` → Web, `Task` → Subagent, …).
2. **Index schema** — add `tool_names VARCHAR[]` to the `events` DDL in
   `db/schema.ts`; bump `SCHEMA_VERSION` to 8.
3. **Connector extraction (×6)** — populate `tool_names` alongside `tool_use_count`:
   - Claude Code: a `list` aggregate over `$.name` of `tool_use` blocks (mirror
     `TOOL_USE_COUNT_EXPR`).
   - Codex / Copilot / pi / opencode / Junie: `blocks.filter(t==='tool_use').map(b => b.name)`
     in each normalize step; add the column to each connector's `read_ndjson` column-type map.
   - Register `tool_names` in `connectors/types.ts` projected columns.
4. **Activity API** — `GET /api/analytics/activity?from&to&tz` →
   `{ heatmap: [{ dow, hour, count }], streak: { current, longest, lastActiveDay } }`.
   Counts `type='user'` events bucketed by local day-of-week × hour (heatmap honors
   `from`/`to`); streak computed all-time from the per-local-day series.
5. **Tools API** — `GET /api/analytics/tools?from&to` → raw `[{ toolName, count }]`
   (UNNEST `tool_names`); honors `from`/`to`.
6. **Web — activity card** — a `ActivityHeatmap` CSS-grid component (7 rows Mon–Sun
   × 24 hour cols, theme-aware intensity, tooltip with count + local hour) plus a
   compact streak stat. Send `Intl.DateTimeFormat().resolvedOptions().timeZone` to
   the API.
7. **Web — tool-usage card** — a `ToolUsageChart` (horizontal category bars,
   descending, raw-tool tooltip), mapping raw counts → categories via the shared fn.
8. **Wire into `AnalyticsPage`** in the agreed order; reuse existing `from`/`to`
   state.
9. **Tests** — see Testing.

## Files affected

- `packages/shared/src/…` — new `ToolCategory` type + `toolCategory()` mapping.
- `packages/server/src/db/schema.ts` — `tool_names` column; `SCHEMA_VERSION` → 8.
- `packages/server/src/connectors/types.ts` — register `tool_names`.
- `packages/server/src/connectors/{claude-code,codex,copilot,pi,opencode,junie}/…` —
  extract tool names next to `tool_use_count`.
- `packages/server/src/routes/analytics-activity.ts` *(new)* — activity endpoint.
- `packages/server/src/routes/analytics-tools.ts` *(new)* — tool-usage endpoint.
  (Or fold both into `routes/analytics.ts` if that fits the existing route layout.)
- `packages/web/src/pages/analytics/ActivityHeatmap.tsx` *(new)*, `ToolUsageChart.tsx` *(new)*.
- `packages/web/src/pages/analytics/AnalyticsPage.tsx` — mount the two cards.
- Tests under the existing integration + unit suites.

## Testing

`npm test` + `npm run typecheck`. Focus on the bug-prone edges (per CLAUDE.md), not
happy-path glue:

- **Tool-name extraction across all six connectors** — canonical names, multiple
  tools per event, zero-tool events.
- **Taxonomy mapping** — unknown tool → `Other`; agent-specific names land in the
  right bucket.
- **Streaks** — gaps, a single active day, today-inclusive boundary, longest ≠
  current.
- **Timezone bucketing** — an event near local midnight lands on the correct local
  day/hour for a non-UTC zone.
- Extend the synthetic-fixture integration suite (real DuckDB index in a temp dir)
  to assert activity buckets + tool counts. Never touches a real agent source.

## Risks / open questions

- **Timezone / ICU (primary risk).** Local-time bucketing needs DuckDB's
  `AT TIME ZONE` (ICU). Confirm ICU is loadable in `@duckdb/node-api`; if not,
  fall back to a client-sent UTC-offset shift (DST-imperfect). Resolve in the
  implementation plan before writing the activity query.
- **Connector coverage.** Six connectors must each populate `tool_names`; a missed
  one silently yields empty tool data for that agent. The cross-connector test guards
  this.
- **`events.ts` storage semantics.** Verify whether `ts` is stored UTC-naive so the
  `UTC → local` conversion is correct; adjust the query accordingly.
- **Out of scope (YAGNI):** message-length distribution, separate day-of-week /
  hour-of-day bars (the heatmap encodes both), and anything LLM-derived.

## Implementation notes (deltas from the plan above)

What shipped differs from the original sketch in a few places, all driven by
review findings and UX feedback:

- **Activity unit excludes subagent + fork rows.** The plan said "user prompts =
  `events.type = 'user'`". The whole-branch review found this counts sidechain
  (subagent-internal) turns and fork/resume copies — a ~2.6× over-count on a real
  index. The activity heatmap and streak queries add `AND NOT e.is_sidechain AND
  e.forked_from_session_id IS NULL`, so they count genuine human prompts only.
  (User rows carry a NULL `message_id`, so the `usage_canonical` election does not
  dedup them — the explicit filter is required.)
- **Dedicated "Activity" view.** Rather than mounting the two cards inside
  *Overview* (whose group-by/time controls don't affect them), they live in a new
  third segment beside *Overview* / *Session efficiency*.
- **Tool usage is attributed by agent.** `GET /api/analytics/tools` groups by tool
  **and** `sessions.connector_id`; the tooltip shows `tool · agent` (e.g.
  `apply_patch · opencode`). `ToolUsageRow` gained an `agent` field. (This reverses
  the original "per-agent tool split = out of scope" line, on user request.)
- **Timezone: offset-shift, no ICU.** No existing ICU usage in the repo, so the
  client sends `tzOffsetMinutes` and the server buckets with `to_minutes()` (DST-
  imperfect but dependency-free). `events.ts` confirmed UTC-naive.
- **Compact heatmap.** Fixed ~14px GitHub-punchcard cells (`width: fit-content`)
  instead of cells stretched to full width.
- **`tool_names` stored only on `events`** (comma-joined VARCHAR, like
  `sessions.models`); `sessions` was not touched.
