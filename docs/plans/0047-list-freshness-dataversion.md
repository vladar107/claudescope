# 0047 — List freshness: dataVersion idle polling

- **Status:** done
- **Date:** 2026-07-16
- **PR:** [#64](https://github.com/vladar107/claudescope/pull/64)

## Context

After the initial index build, `StatusProvider` stopped polling `/api/health`
entirely: `ready` never flips back to false, and a steady-state incremental
reindex pass is transient (sub-second), so its `indexing` progress is
practically unobservable by any poll. Consequence: sitting on the Browse page
or a project's session list, new sessions landed by the ~15s auto-reindex never
appeared without a manual reload — at odds with the live-monitoring direction
of 0045/0046 (the single-session view already live-refreshes via fingerprint
polling). A long-lived tab also never learned about `updateAvailable`, since
that nudge rode the same stopped poll.

## Goal

Browse and session lists silently pick up newly indexed data while the app is
open, at negligible steady-state cost, without a new transport.

## Decisions

- **Expose a monotonic `dataVersion` on `/api/health`** — bumped only when a
  pass actually changed derived data (incl. mid-first-build partial rebuilds),
  never on no-op passes. A durable signal is required because the transient
  `indexing` field can't be caught by a slow poll.
- **Slow idle poll (10s) instead of stopping** — rejected SSE/WebSocket push:
  it adds connection lifecycle (reconnects, dev-proxy, daemon restarts) to a
  plain request/response API, and with a 15s indexer cadence push buys ~7s of
  latency over polling. Rejected focus-only refetch: it misses the "watching
  the list while an agent works" case.
- **Clients compare by inequality, not greater-than** — the counter resets on
  daemon restart; a reset then triggers one harmless refetch.
- **Refetches are silent** (no spinner, keep scroll) and skipped while
  `building`, where the existing fast-poll refetch paths already run.

## Approach

1. `data/index.ts`: module-level `dataVersion` counter + `getDataVersion()`;
   bump after the changed-pass finalize and after each mid-first-build partial
   rebuild; leave the no-op early-return untouched.
2. `/api/health` returns it; `HealthResponse` gains `dataVersion: number`.
3. `StatusProvider`: replace "stop when ready+idle" with a 10s idle poll;
   expose `dataVersion` (null until the first response).
4. A shared `useDataVersionRefetch(refetch)` hook: refetch silently when the
   observed `dataVersion` moves past the version last fetched at. It records
   the first observation instead of fetching (the mount fetch covered it) and
   holds recording while `building` (the fast-poll build paths own that
   window), so build-end always triggers one catch-up refetch.
5. Wire the hook into `BrowsePage`, `SessionList`, and `ProjectLayout` — the
   last found by end-to-end verification: the list refreshed while the header
   stats (sessions/tokens/cost) above it stayed stale.

## Files affected

- `packages/server/src/data/index.ts` — counter, getter, two bump sites.
- `packages/server/src/routes/index.ts` — health payload.
- `packages/shared/src/api.ts` — `HealthResponse.dataVersion`.
- `packages/web/src/status/StatusProvider.tsx` — idle poll, expose field.
- `packages/web/src/status/useDataVersionRefetch.ts` — the shared hook.
- `packages/web/src/pages/browse/BrowsePage.tsx` — silent refetch on change.
- `packages/web/src/pages/browse/SessionList.tsx` — same.
- `packages/web/src/pages/browse/ProjectLayout.tsx` — header stats, same.

## Testing

- Integration test in `api.integration.test.ts`: a no-op reindex pass must NOT
  bump `dataVersion` (else idle clients refetch every 15s for nothing); a pass
  that reloads a touched fixture must bump it.
- End-to-end (Playwright against a sandboxed server, see
  `.claude/skills/verify/SKILL.md`): new sessions/projects appear on open list
  pages within reindex + idle-poll latency with no page reload; header stats
  update in step; the page recovers and keeps updating across a daemon restart
  (dataVersion reset).
- `npm test`, `npm run typecheck`.

## Risks / open questions

- Steady-state cost is one tiny health GET per 10s per open tab on loopback —
  accepted.
- The lists refetch wholesale (no delta); fine at current list sizes, and
  consistent with how the build-time refetch already works.
