# 0070 — Reliable update status and identifier search

- **Status:** in-progress
- **Date:** 2026-08-14
- **PR:** pending

## Context

Two user-visible paths currently overstate their reliability:

- The Settings page renders `up to date` whenever its one-time `/api/system`
  response does not report an update. That includes an unknown registry state
  and a result read from the documented 24-hour cache. It also does not react
  when the health poll later learns that an update exists.
- Transcript search builds DuckDB FTS with its default ignore expression, which
  removes every non-alphabetic character. Versions, ticket numbers, and other
  numeric identifiers therefore never enter the FTS dictionary; for example,
  messages containing `v0.17.0` exist in the index while searches for
  `v0.17.0`, `0.17.0`, or `17` return no hits.

The default automatic update-check cadence remains once per day so this fix
does not silently expand ClaudeScope's outbound network behavior.

## Goal

Make update status honest and refreshable on demand, and make transcript search
reliably find versions, Jira-style ticket keys, and numeric identifiers without
regressing prose-oriented BM25 search.

## Decisions

- **Keep the 24-hour automatic cache and add an explicit fresh check** — the
  Settings action can bypass the cache without increasing background requests.
- **Never label an unknown/cached-negative state as current** — Settings will
  distinguish a cached no-update result from a fresh user-triggered check, and
  will consume the live health-poller update value when one arrives.
- **Extend the existing FTS index instead of adding a parallel search store** —
  preserve digits while continuing to split punctuation, use conjunctive BM25
  for queries containing digits, and rank literal full-query matches first.
- **Rebuild the derived index through schema v14** — existing installations must
  regenerate their FTS dictionary with numeric terms.

## Approach

1. Make daemon update refresh report success, add a force-refresh system route,
   and expose it through the typed web client.
2. Add the Settings action and honest cached/unknown/fresh status rendering,
   while keeping the health poll as the live source for newly detected updates.
3. Reconfigure DuckDB FTS to retain digits, select conjunctive identifier
   matching, and prioritize exact query substrings in result ordering.
4. Bump the derived schema, document the manual network check, and validate the
   focused paths plus the repository's normal test/typecheck/build gates.

## Files affected

- `packages/server/src/update-check.ts` — forceable refresh with success state.
- `packages/server/src/routes/system.ts` — on-demand update-check endpoint.
- `packages/web/src/api/client.ts` — typed endpoint call.
- `packages/web/src/pages/settings/SettingsPage.tsx` — update action and honest
  status rendering.
- `packages/server/src/data/index.ts` — numeric-aware FTS configuration.
- `packages/server/src/routes/search.ts` — identifier query semantics and exact
  match ranking.
- `packages/server/src/db/schema.ts` — schema v14 rebuild trigger.
- `README.md` / `SECURITY.md` — document the explicit on-demand registry check.
- `docs/plans/README.md` — plan index entry.

## Testing

- Run the existing update-check and API integration suites.
- Probe a synthetic FTS corpus for `v0.17.0`, `0.17.0`, `17`, `JIRA-123`, and
  `123`, confirming exact identifiers rank before separated-term matches.
- Run `npm test`, `npm run typecheck`, `npm run build`, and the search
  performance scenario if its local prerequisites are available.

## Risks / open questions

- Numeric terms enlarge the FTS dictionary and may add matches to mixed prose
  queries containing numbers. Conjunctive matching for digit-bearing queries
  bounds that noise; exact full-query matches sort first.
- A manual update check adds a registry request only after an explicit click.
  Failure must remain visible rather than falling back to a false success state.
