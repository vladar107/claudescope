# 0081 — Skill usage and exact-match search in the web

- **Status:** done
- **Date:** 2026-09-03
- **PR:** https://github.com/vladar107/claudescope/pull/104

## Context

Plans 0078–0080 (issue #100) added two things to the API that only the CLI and
MCP expose: `kind=skill` on `/api/analytics/tools` and `literal=true` on
`/api/search`. In the web:

- The Efficiency view's "Tool usage" card calls the tools endpoint for
  `kind=tool` only and buckets by category (`ToolUsageChart`), so `Skill`
  calls fold into one bar and skill names never appear.
- The Search page (`SearchPage.tsx`) keeps its state in the URL
  (`?q=&project=&type=&scope=`) and is BM25 only, so an error line pasted
  there gets the ranking noise the issue complained about.

The web's tests are pure helpers under `packages/web/test` (no DOM), and
Playwright is a dev dependency used by the perf suite; the `verify` skill
documents a sandboxed launch against fixture transcripts.

## Goal

From the web, see which skills were used how often, per agent, under the same
project and date scope as the rest of the Efficiency view; and search an exact
string (an error line, an identifier) with results that open the session at
the matching message. Demonstrated with screenshots of the running app.

## Decisions

- **A second card, not a mode on "Tool usage"** — a `SkillUsageChart` card
  under "Tool usage" in the same `tv-analytics__charts` column, one bar per
  skill name, tooltip with the per-agent split (the `ToolUsageChart` tooltip
  pattern, without its category bucketing). Reusing `ToolUsageChart` with a
  switch was rejected: categories are meaningless for skills, and the two
  charts answer different questions side by side.
- **Own fetch, same scope** — a second `api.analyticsTools({ kind: 'skill' })`
  call under the same conditions as the tools fetch (`view === 'efficiency'`,
  `grain === 'agents'`, project scope, date range), in its own state so one
  failing does not blank the other. The client gains `kind`.
- **`exact=1` in the URL** — the toggle joins the existing URL-state pattern
  (`patchParams`), so an exact search is shareable and survives reload. Sent
  as `literal: true`; `SearchParams` gains `literal`.
- **Toggle plus a one-line hint** — a checkbox labelled "Exact" after the
  role select; when on, a muted line under the controls says the query is
  matched as one case-insensitive substring over transcript text, failed
  tool results, tool and skill names, newest first. The empty state reads
  "No exact matches for …". The memory half of a search stays ranked (the
  route only switches the transcript half); the hint says so.
- **No new unit tests** — the change is wiring and rendering with no
  bug-prone logic of its own; the server behaviour it reads is already
  covered by the literal-search and tools-endpoint integration tests.
  Verification is typecheck, build, and driving the built app.

## Approach

1. `packages/web/src/api/client.ts`: `kind` on `analyticsTools`, `literal` on
   `SearchParams` / `search`.
2. Analytics: `skills` state and fetch in `AnalyticsPage.tsx`; new
   `SkillUsageChart.tsx`; a `ChartCard` titled "Skill usage" with hint
   "calls by skill".
3. Search: `exact` read from the URL, checkbox in `tv-search__controls`, hint
   line and empty-state wording, `literal` passed to the API; a few lines in
   `search.css` for the checkbox.
4. Docs: one sentence each in the README's analytics and search descriptions;
   this plan + index row.
5. Verify: `npm run typecheck`, `npm test`, `npm run build`; then the demo
   below.

## Files affected

- `packages/web/src/api/client.ts` — `kind` param, `literal` param.
- `packages/web/src/pages/analytics/AnalyticsPage.tsx` — skills fetch + card.
- `packages/web/src/pages/analytics/SkillUsageChart.tsx` — new.
- `packages/web/src/pages/search/SearchPage.tsx`, `search.css` — exact
  toggle, hint, empty state.
- `README.md`, `docs/plans/README.md`.

## Testing

- `npm run typecheck`, `npm test`, `npm run build`.
- **Demo (sandboxed, per the `verify` skill):** launch the built server on a
  scratch port with `CLAUDESCOPE_HOME` and every source dir pointed at a
  temp dir; write Claude Code fixture sessions with `Skill` calls for three
  skills across two sessions (one of them a split message, so the corrected
  counting shows) and a failed `Bash` result whose error line recurs in two
  sessions. Drive the built app with Playwright: Analytics → Efficiency →
  screenshot the "Skill usage" card; Search with the error line and
  `exact=1` → screenshot the results; click through to the session. Present
  the screenshots in the conversation. Kill the server afterwards.

## Risks / open questions

- Long skill names (`plugin:skill`) need a wider Y axis than tool categories;
  set from the longest label, capped.
- Exact mode applies to transcripts only; memory hits stay ranked. Stated in
  the hint rather than hidden.
- A "recurring failures" aggregate (top error lines across sessions) is out
  of scope; it needs a new endpoint and the error-line heuristic from plan
  0080, and is worth adding only if exact search turns out to be used for it
  repeatedly.
