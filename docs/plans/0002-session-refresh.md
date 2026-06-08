# 0002 — In-place session refresh

- **Status:** done
- **Date:** 2026-06-08
- **PR:** (landed directly on `main` as `281f75a`; backfilled)

## Context

When a Claude Code session is still being written to (a conversation is actively
running), the open session view didn't pick up new turns — the only way to see
them was a full browser reload (F5), which loses scroll position and re-shows the
full-page loading spinner.

We wanted the **cheap** version: re-fetch the current session and swap the new
content in place, preserving scroll position — no page reload, no full-screen
spinner.

## Goal

A **Refresh** control (button + ⌘R / Ctrl+R) in the session header that re-pulls
the latest messages in place, keeping the reader's scroll position.

## Decisions

- **Soft refresh, not the existing `reloadKey` path** — the initial-load effect
  does `setData(null)` + full-page `<Spinner>`, which unmounts `SessionView` and
  loses scroll. A separate path that keeps `data`/the view mounted preserves
  position for free, because thread turns are keyed by `uuid` and new turns
  append at the end (existing DOM nodes are reused).
- **No reindex on refresh (the "cheap" tradeoff)** — `GET /api/sessions/:id`
  reads the JSONL fresh from disk every request, so new main-transcript turns
  appear without a reindex. `meta` (header token/cost/msg stats) comes from the
  DuckDB index and may lag until the next reindex; brand-new *subagent* files
  also won't appear until then. Accepted; a future "deep refresh" could
  `POST /api/reindex` first.
- **⌘R intercept with an escape hatch** — a keydown listener calls
  `preventDefault()` on ⌘R/Ctrl+R and runs the soft refresh; ⌘⇧R still falls
  through to the browser's hard reload.
- **Gate the deep-link hash scroll to first load only** — it previously ran on
  every `data` change, so a refresh would yank a `#uuid`-deep-linked reader back
  to that anchor. Now fires once per session id.

## Approach

1. `SessionPage`: add `refreshing` state + a `refresh()` callback that re-fetches
   without nulling `data`/flipping `loading`; cancel in-flight refreshes via an
   `AbortController` ref; a failed refresh keeps current content.
2. Add the ⌘R/Ctrl+R keydown listener (excludes Shift/Alt) that calls `refresh()`.
3. Gate the hash-scroll effect to fire once per session id.
4. `SessionView`: accept `onRefresh`/`refreshing`; render a `⟳ Refresh` button in
   `.tv-session__crumbs` (reusing `tv-linkbtn`), showing an inline spinner and
   disabling while refreshing.
5. Minimal disabled-state CSS in `session.css`.

## Files affected

- `packages/web/src/pages/session/SessionPage.tsx` — soft-refresh state/callback,
  ⌘R listener, hash-scroll gating, button in the header crumbs.
- `packages/web/src/pages/session/session.css` — disabled-state styling.
- No server, shared-types, or API-client changes — `api.getSession` reused as-is.

## Testing

- `npm run typecheck` and `npm test` (69 tests) pass.
- Manual: open a session, scroll partway, append a turn to its JSONL, click
  **Refresh** (or press ⌘R) → the new turn appears at the bottom, no full-page
  spinner, scroll position preserved. ⌘⇧R still hard-reloads.

## Risks / open questions

- Header `meta` stats lag until the next reindex (documented tradeoff).
- ⌘R is only overridden while the Claudescope tab is focused — the only place a
  web page can intercept the key.
- Future: a "deep refresh" variant that reindexes first; optional polling / a
  "new messages available" indicator.
