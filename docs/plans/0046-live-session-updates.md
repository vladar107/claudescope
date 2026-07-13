# 0046 — Live session updates (fingerprint polling + stick-to-bottom)

- **Status:** in-progress
- **Date:** 2026-07-13
- **PR:** <link, once opened>

## Context

While an agent is still writing a transcript, the open session page only updates
on manual ⌘R. The session *content* is already served live — `GET
/api/sessions/:id` re-reads the JSONL from disk on every request
(`data/session-loader.ts`); only the header `meta` and the `session_id → [file
paths]` mapping come from the DuckDB index (≤15s stale via the interval
reindex). So "live updates" needs only a cheap change signal plus an automatic
trigger for the existing scroll-safe soft `refresh()` in SessionPage.

## Goal

A session whose transcript is actively growing updates in the open session page
within ~2s, silently (no spinner flash), keeping a bottom-pinned reader pinned —
at near-zero cost when nothing is live.

## Decisions

- **Split design** — the 15s interval reindex stays untouched (index path); a
  new read-only per-session fingerprint probe serves the view path. Rejected:
  *reindex-driven UI* (a changes-pass rebuilds sessions/FTS/checkpoint — far too
  heavy at 2s cadence, and ~9s median latency), *fs watchers* (much larger
  cross-platform effort; can be layered on later feeding the same fingerprint),
  *SSE* (new infra class, no real latency win over localhost polling).
- **Hybrid fingerprint** — live `fs.stat` of the session's known files **plus**
  the files-table row set. Growth shows up within one poll; a brand-new subagent
  file rides the next reindex (documented ≤15s blind spot) and then joins the
  live-stat set.
- **Connector hook `statFile?`** — opencode's paths are synthetic
  `<dbPath>#<sessionId>` keys that can't be `fs.stat`ed; it probes SQLite
  instead. All six file-backed connectors use the caller's `fs.stat` default.
- **Polling, not push** — mirrors the established StatusProvider pattern: ~2s
  while the session looks live (last modification within 3min), 5s after a
  transient error, stop when idle/hidden, revive on tab visibility/focus.
- **Stick-to-bottom without a toggle** — pin only a reader already near the
  bottom, via a short rAF hold (the `holdAnchor` pattern) because appended turns
  mount progressively and Shiki swaps in async. No live badge/chip anywhere.

## Approach

1. Shared type `SessionFingerprintResponse { fingerprint, lastModifiedMs }`.
2. Server: optional `statFile?` on `AgentConnector`; opencode `statSession`
   (the `listSessions` change-signal expression targeted at one id);
   `computeSessionFingerprint` (files rows → per-file live stat →
   sha1 over row count + `path:mtime:size` parts); thin
   `GET /api/sessions/:id/fingerprint` route (404 shape of the detail route).
3. Web: `api.sessionFingerprint`; `refresh({silent}) → Promise<boolean>` in
   SessionPage (spinner only for manual refresh; resolves true when the swap
   landed); `useLiveSession` poller hook; `isNearBottom`/`holdBottom` helpers
   wired into the refresh swap path.
4. Integration tests for the probe's contracts.

## Files affected

- `packages/shared/src/api.ts` — `SessionFingerprintResponse`.
- `packages/server/src/connectors/types.ts` — optional `statFile?`.
- `packages/server/src/connectors/opencode/{db,opencode}.ts` — `statSession` +
  hook implementation.
- `packages/server/src/data/fingerprint.ts` — new; `computeSessionFingerprint`.
- `packages/server/src/routes/sessions.ts` — fingerprint route.
- `packages/web/src/api/client.ts` — `sessionFingerprint`.
- `packages/web/src/pages/session/useLiveSession.ts` — new; poller +
  stick-to-bottom helpers.
- `packages/web/src/pages/session/SessionPage.tsx` — silent refresh, poller +
  pin wiring.
- `packages/server/test/session-fingerprint.integration.test.ts` — new.
- `packages/server/test/opencode.integration.test.ts` — one fingerprint case.

## Testing

- `npm test` / `npm run typecheck`.
- Integration: fingerprint flips on file growth **without** reindex; a new
  subagent file flips it only **after** reindex (documents the blind spot);
  unknown session 404s; opencode probe works via SQLite (synthetic path never
  `fs.stat`ed) and flips on a new `part` row without reindex.
- Manual: dev server + a fixture transcript appended every few seconds — new
  turns appear within ~2s with no spinner; bottom-pinned reader follows; a
  scrolled-up reader stays put; polling stops when the tab hides / the session
  goes idle and revives on focus.

## Risks / open questions

- Blocks inside a turn are index-keyed (`ThreadView.tsx`), so a *mutating*
  in-progress final turn could mis-bind expand state; pure turn appends (the
  common case) are unaffected. Revisit if it bites.
- A fingerprint 404 permanently stops the poller; during a schema-bump rebuild
  an open page could go quiet until re-navigation. Accepted — manual refresh
  still works.
- fs watchers remain a possible future upgrade; they would feed the same
  fingerprint/version and leave the client untouched.
