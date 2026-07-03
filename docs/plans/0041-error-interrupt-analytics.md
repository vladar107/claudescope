# 0041 — Error & interrupt analytics

- **Status:** done
- **Date:** 2026-07-03
- **PR:** [#53](https://github.com/vladar107/claudescope/pull/53)

## Context

Roadmap 0035, slice 6 (B3 UI). The v10 index (plan 0039) projected
`events.tool_error_count` but nothing surfaced it, and user interrupts were
sitting unqueried in `events.text_content`. This slice adds the read layer:
a per-agent errors/interrupts route and an Analytics view, with the same
null-not-zero availability contract the cross-agent comparison (plan 0037)
established.

## Goal

An Analytics → Errors view answering "how often do tool calls fail per agent,
and how often do I interrupt Claude?" — honest about which agents can't report
either signal.

## Decisions

- **Errors sum over whichever rows carry the tool_result** — for Claude
  Code/Codex the `is_error` flag lives on user rows, so the aggregation must
  not filter on `type = 'assistant'` (tool *calls* do, matching the tools
  breakdown). Fork copies of result rows all have NULL message ids (every one
  is `usage_canonical`), so fork copies are excluded by
  `forked_from_session_id IS NULL` instead; if the original file is later
  deleted the surviving copy goes uncounted — accepted edge, same as the
  interrupt count.
- **Interrupt marker is prefix-anchored** — verified against real transcripts:
  Claude Code stores `[Request interrupted by user]` /
  `[Request interrupted by user for tool use]` as the user-message text. A
  prefix LIKE counts those without false-positiving on messages that *quote*
  the marker mid-text. Same sidechain/fork exclusions as the activity
  punchcard. Claude-Code-only → null for every other agent.
- **`errorSignalsByAgent` is exported** for the digest (slice 7) to reuse —
  one aggregation, two consumers.
- **NULL stays NULL** — Junie/Antigravity formats carry no error signal;
  DuckDB `SUM` of all-NULL groups stays NULL and the route passes it through
  as `toolErrors: null` with an `availabilityNote`. Copilot's
  permission-denials counting as errors is carried forward as an open question
  from plan 0039 (noted per-row).

## Approach

1. `packages/server/src/routes/analytics-errors.ts` — `errorSignalsByAgent`
   (scoped sessions CTE → per-agent sums) + `GET /api/analytics/errors`
   shaping n/a semantics; registered in `routes/index.ts`.
2. Shared types `ErrorAnalyticsRow`/`ErrorAnalyticsResponse` in
   `packages/shared/src/api.ts`.
3. Web: `ErrorsTable.tsx` (efficiency-table classes, n/a cells with tooltips),
   an `errors` view + project scope select in `AnalyticsPage.tsx`, `.tv-na` /
   `.tv-analytics__select` styles. (Both also land on the sibling PR #49 —
   dedupe at rebase.)

## Files affected

- `packages/server/src/routes/analytics-errors.ts` (new), `routes/index.ts`
- `packages/shared/src/api.ts`
- `packages/web/src/pages/analytics/ErrorsTable.tsx` (new),
  `AnalyticsPage.tsx`, `analytics.css`, `packages/web/src/api/client.ts`
- `packages/server/test/analytics-errors.integration.test.ts` (new)

## Testing

Integration suite over synthetic fixtures: Claude Code `is_error` counted with
a real rate (and a real 0 stays 0), Junie `toolErrors: null` (never 0),
genuine interrupt counted while a mid-text quote of the marker is not,
project-slug scoping. `npm test` + `npm run typecheck` green.

## Risks / open questions

- Copilot permission-denials count as errors — split "denied" from "failed"
  when a consumer needs it (carried from plan 0039).
- Interrupt detection depends on Claude Code's marker text; a upstream wording
  change would silently zero the metric (the fixture pins today's wording).
