# 0036 — API seams for agent consumers (windowing, limits, plain snippets, shared redact/markdown)

- **Status:** done
- **Date:** 2026-07-03
- **PR:** [#48](https://github.com/vladar107/claudescope/pull/48)

## Context

Slice 1 of the [0035 roadmap](./0035-agent-access-and-analytics-roadmap.md)
(Track A). The upcoming MCP server and CLI query mode must never dump a whole
session into an agent context: `GET /api/sessions/:id` returns full tool
inputs/results for the entire thread (megabytes for large sessions),
`GET /api/sessions` has no LIMIT, and search snippets are HTML
(`<mark>`-wrapped, entity-escaped). The Markdown renderer and redaction helper
that agent-facing output will reuse lived in `packages/web` where the server
cannot import them.

## Goal

Token-frugal request shapes on the existing API — windowing, truncation,
row limits, plain-text snippets — with the no-params paths byte-identical to
today's behavior, plus the redact/markdown/diff helpers hoisted into
`packages/shared` for server-side reuse.

## Decisions

- **`around` uuid-anchored windows take precedence over `offset`/`limit`** —
  search hits return `messageUuid`, so "open the window around this hit" is the
  primary agent flow. An `around` uuid found inside a subagent thread resolves
  to the main-thread turn that spawned the run (`spawnUuid`); an unresolvable
  uuid falls back to the thread start with `anchorFound: false` (the caller can
  tell the anchor missed rather than silently getting the wrong slice).
- **Windowed responses include only subagent runs spawned inside the slice**
  (`spawnUuid` ∈ slice). Runs that never correlated to a spawn point have no
  anchor to window against and are dropped from windowed responses; the
  full-session (no-params) path keeps returning everything.
- **`maxToolChars` is orthogonal to windowing** — it truncates tool
  input/result strings (with an explicit `… [truncated, N more chars]` marker)
  and does not by itself add a `window` object.
- **The whole pure diff module moved to shared, not just the markdown
  renderer** — the renderer needs `lineDiff` to render Edit diffs, and a
  server-side caller can't reach `packages/web`. `components/diff.ts` stays as
  a re-export shim (web imports untouched; the Shiki-specific `MAX_HIGHLIGHT`
  stays web-side). This also pre-stages the 0035 slice-5 changeset hoist.
- **Snippet format is a request param (`format=plain`), not a second response
  field** — no payload duplication for the web UI; the default stays HTML.

## Approach

1. `packages/shared`: new `redact.ts` (moved `redactText`), `diff.ts` (moved
   LCS diff primitives), `markdown.ts` (moved `sessionToMarkdown` +
   `ExportOptions`, new `threadItemsToMarkdown` and `truncateText`, optional
   `maxToolChars` capping of tool payloads). Web re-imports via
   `@claudescope/shared`; `pages/session/export.ts` deleted.
2. `packages/server/src/data/window.ts`: pure `resolveWindow` /
   `subagentsInWindow` / `truncateToolChars` over the assembled thread.
3. `GET /api/sessions/:id`: `offset`/`limit`/`around`/`radius`/`maxToolChars`
   params; adds `window: { offset, limit, total, anchorFound? }` when windowing
   params are present. No params → unchanged full response.
4. `GET /api/sessions`: positive-int `limit` param (SQL LIMIT).
5. `GET /api/search`: `format=plain`; `makeSnippet` extracted to
   `routes/snippet.ts` with the format switch (applies to session and memory
   snippets).
6. Shared API types: `SessionDetailQuery`, `SessionWindow`,
   `SessionsQuery.limit`, `SnippetFormat`, `SearchQuery.format`.

## Files affected

- `packages/shared/src/{redact,diff,markdown}.ts` (new) + `index.ts` exports.
- `packages/shared/src/api.ts` — new query/response types.
- `packages/web/src/components/diff.ts` — re-export shim (+`MAX_HIGHLIGHT`).
- `packages/web/src/pages/session/export.ts` — deleted;
  `ExportMenu.tsx` imports `sessionToMarkdown` from shared.
- `packages/server/src/data/window.ts` (new), `routes/snippet.ts` (new),
  `routes/sessions.ts`, `routes/search.ts`.
- Tests: `packages/shared/test/markdown.test.ts` (moved from
  `packages/web/test/export.test.ts` + truncation edges),
  `packages/server/test/{window,snippet}.test.ts` (new),
  `packages/server/test/api.integration.test.ts` (windowing/limit/format
  cases).

## Testing

`npm test` (334 passing) and `npm run typecheck`. Focused edges: around-uuid
miss fallback, subagent-uuid anchor resolution, boundary clamping, truncation
marker counts and non-mutation, plain-vs-html snippet escaping (including a
term containing `<`), no-params responses carrying no `window`.

## Risks / open questions

- Windowed `subagents` drop uncorrelated runs by design; if an MCP consumer
  needs them, a follow-up param can opt back in.
- `offset` addressing is positional over the assembled thread — stable for a
  finished session, but a session that grows between calls shifts indexes;
  `around` anchoring is the recommended scheme for agents.
