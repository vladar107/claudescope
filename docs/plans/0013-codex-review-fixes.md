# 0013 — Codex review fixes: project-ID collisions, stale aux rows, image tool results

- **Status:** done
- **Date:** 2026-06-12
- **PR:** <link, once opened>

## Context

An external (Codex) code review surfaced three findings, all verified against the
code:

1. **Lossy project IDs.** `projectIdFromCwd` collapses every non-alphanumeric
   run to `-`, so distinct cwds collide (`/a/b-c` vs `/a/b/c`, `/tmp/foo-bar` vs
   `/tmp/foo_bar`). The sessions/search routes resolve the slug back to a cwd
   with `.find()`, silently routing colliding projects to the first match, and
   `/api/projects` emits duplicate ids for colliding cwds. The file's own doc
   comment even (falsely) claimed the slug was lossless.
2. **Stale `titles`/`pr_links` rows.** The indexer's `loadFile` deletes a file's
   `events` rows but only upserts the aux tables; the file-removal path deletes
   only `events` + `files`. A removed `ai-title`/`pr-link` line therefore
   resurrects via the LEFT JOIN in `rebuildSessions`. Mostly theoretical
   (transcripts are append-only in practice), but the fix is a few lines.
3. **Image blocks in tool results render as JSON.** The shared contract allows
   `tool_result.content` to carry image blocks and the parser passes them
   through verbatim, but `renderResultBlocks` JSON-stringifies anything that
   isn't text/thinking — a base64 dump. The `Read` tool branch was worse: an
   image-only result rendered as an empty code block. An inline image renderer
   (`extractImage`) already existed, private to `pages/session/blocks.tsx`.

## Goal

Fix all three: collision-proof project IDs, aux rows that die with their source
lines, and tool-result images rendered inline.

## Decisions

- **ID format `<slug>-<hash8>`** (8 hex chars of SHA-256 of the full cwd; hash
  alone when the slug is empty) — keeps ids human-readable while guaranteeing
  uniqueness. A reversible encoding was rejected as uglier in URLs. Existing
  bookmarked URLs change format — accepted for a localhost tool.
- **No changes at the resolution sites** — every consumer derives ids by calling
  `projectIdFromCwd`, so fixing the function fixes routing; the `.find()` scans
  become unambiguous automatically.
- **Targeted aux deletes, not derive-on-rebuild** — deleting
  `titles`/`pr_links` rows for the file's session ids before the events delete
  (and in the removal path) is a four-line fix; rebuilding the aux tables from
  events was rejected as a larger change for no extra benefit. Safe because
  sessions are 1:1 with files across all three connectors.
- **Share `extractImage` via `components/image.ts`** — `ToolBlock` (components)
  must not import from `pages/`, so the helper moved to the components barrel
  and `blocks.tsx` imports it from there.

## Approach

Three independent chunks, executed in parallel:

1. `projectIdFromCwd`: append the hash suffix, fix the doc comments, update the
   format-pinning tests, add a collision-resistance test.
2. Indexer: delete aux rows for the file's session ids before
   `DELETE FROM events` in `loadFile` (subquery reads `events`, so order
   matters) and in the removal loop in `doReindex`; add an integration
   regression test (index with `ai-title` → rewrite without it → title falls
   back to the first user message).
3. Web: extract `extractImage` to `components/image.ts`; render image blocks in
   `renderResultBlocks` with the same `tv-attachment` figure markup as
   attachments (JSON fallback for malformed blocks); make the `Read` branch fall
   through to `ResultSection` when the result has non-text blocks and no text.

## Files affected

- `packages/server/src/data/project-id.ts` — slug+hash id; accurate doc comments.
- `packages/server/test/util.test.ts` — updated format pins (independently
  verified against `sha256` of the full cwd), new collision test.
- `packages/server/src/data/index.ts` — aux-row deletes in `loadFile` and the
  file-removal path, both before the events delete.
- `packages/server/test/api.integration.test.ts` — stale ai-title regression test.
- `packages/web/src/components/image.ts` (new) — shared `extractImage`.
- `packages/web/src/components/index.ts` — barrel export.
- `packages/web/src/components/ToolBlock.tsx` — image branch in
  `renderResultBlocks`; `Read` branch image handling.
- `packages/web/src/pages/session/blocks.tsx` — import the shared helper,
  local copy deleted.

## Testing

- `npm test` — 137/137 pass, including the new collision and stale-title tests.
- `npm run typecheck` — clean across all packages.
- `vite build` for the web package — clean.

## Risks / open questions

- All project URLs change format (hash suffix). Accepted.
- `Read` results carrying **both** text and an image render only the text (the
  image is dropped) — in practice Claude Code returns image-only results for
  image reads, so this path is theoretical. Revisit if a tool emits mixed
  text+image results.
