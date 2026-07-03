# 0042 — Week-in-review digest (page + copy-as-Markdown + CLI)

- **Status:** done
- **Date:** 2026-07-03
- **PR:** [#53](https://github.com/vladar107/claudescope/pull/53)

## Context

Roadmap 0035, slice 7 (B4) — the composition layer built last, on purpose:
it rolls up what slices 1–6 produced (session aggregates, `file_edits` churn,
the shared error/interrupt aggregation, streaks) into one "what happened this
week" answer, in three shapes: an Analytics view, a copyable Markdown
document, and a `claudescope digest` CLI command.

## Goal

`GET /api/analytics/digest?from=&to=` (default: last 7 days) plus an
Analytics → Digest view with range presets and "Copy as Markdown", plus
`claudescope digest [--from] [--to] [--json]` — where the CLI's human output
and the web copy button emit the **same** Markdown document.

## Decisions

- **Renderer lives in `packages/shared` (`digest-markdown.ts`)** — the web
  can't import from the server package, and the CLI shouldn't duplicate the
  document; shared is the only seam both reach (the `shape.ts` helpers stay
  server-side because only agent-facing consumers use them).
- **No schema; session-atomic composition** — every sub-query hangs off one
  scoped-sessions CTE (range on `started_at`), consistent with
  /api/analytics/sessions and the errors route. Token/cost totals are
  session-level sums (already usage-deduped), which naturally cover only
  usage-reporting agents.
- **Reliability reuses `errorSignalsByAgent`** (plan 0041) — agents whose
  formats carry no error signal are *listed* (`unknownAgents`), never
  zero-counted; `interrupts` is null when no Claude Code sessions are in range.
- **Streak is all-time (UTC days) as of the range end** — momentum, not a
  range-bound stat; reuses `computeStreaks`. UTC (not client-local like the
  activity punchcard) keeps the CLI and web consistent without threading an
  offset through both.
- **Presets set the page's shared from/to inputs** — one source of truth for
  the range instead of a digest-private range state.

## Approach

1. Shared: `DigestResponse` types + `digestToMarkdown` renderer.
2. Server: `routes/analytics-digest.ts` composing totals, top projects, model
   mix, tool mix, per-agent sessions, biggest session, streak, `file_edits`
   impact, reliability; registered in `routes/index.ts`.
3. Web: `DigestView.tsx` (presets, stat cards, lists, copy button) + a
   `digest` view in `AnalyticsPage.tsx`.
4. CLI: `ApiClient.digest`, `queryDigest` (human output = the shared
   renderer), `digest` case + help in `cli.ts`, README example.

## Files affected

- `packages/shared/src/api.ts`, `digest-markdown.ts` (new), `src/index.ts`
- `packages/server/src/routes/analytics-digest.ts` (new), `routes/index.ts`,
  `src/agent/api-client.ts`, `src/agent/query.ts`, `src/cli.ts`
- `packages/web/src/pages/analytics/DigestView.tsx` (new),
  `AnalyticsPage.tsx`, `analytics.css`, `src/api/client.ts`
- `packages/server/test/analytics-digest.integration.test.ts` (new),
  `packages/shared/test/digest-markdown.test.ts` (new), `README.md`

## Testing

Integration: totals compose across a usage-reporting and a no-signal agent
without zeroing; code impact from canonical `file_edits`; empty range → zero
totals, empty lists, null biggest session, no NaNs. Renderer: n/a error rate,
no-signal note, empty-section omission, empty-range document. `npm test` +
`npm run typecheck` green.

## Risks / open questions

- The digest's default range uses the server clock (UTC); a CLI run just after
  midnight local may bound the week differently than the web presets (which
  are local) — acceptable for a summary, revisit if it confuses.
- Churn numbers are agent-reported (plan 0039 caveat), restated in the UI hint
  and the Markdown footer line.
