# 0063 — Show detected agents in Memory

- **Status:** done
- **Date:** 2026-07-29
- **PR:** https://github.com/vladar107/claudescope/pull/84

## Context

The Memory landing page renders one card for every connector compiled into
ClaudeScope. On a machine with only Claude Code and Codex data, this makes six
absent agents look like locally available choices. The app already has a
canonical detection rule for `/api/sources`: a connector is local when its
configured transcript source path exists. Actual memory content is also a local
signal because a global instruction file can predate the transcript directory.

## Goal

Only show agents detected on the current machine in the Memory card grid, while
preserving the useful "no memory store" state for detected transcript-only
agents.

## Decisions

- **Reuse source-path detection** — use the same connector helper for
  `/api/sources` and `/api/memory`; Memory may additionally retain connectors
  that contributed real memory content. Do not add CLI-binary probing.
- **Filter on the server** — keep the API contract truthful and avoid sending
  unavailable connector choices for the web client to discard.
- **Keep detected agents without memory visible** — the issue is absent agents,
  not the explanatory empty state for a locally present transcript source.

## Approach

1. Extract the existing source-path existence check into the connector registry.
2. Build Memory overviews from that detected connector list.
3. Update contract comments and the focused overview test for the filtered list.
4. Run the relevant test, full tests, typecheck, and a final diff review.

## Files affected

- `packages/server/src/connectors/registry.ts` — expose detected connectors.
- `packages/server/src/routes/sources.ts` — consume the shared detection helper.
- `packages/server/src/routes/memory.ts` — pass detected connectors to the
  overview builder.
- `packages/server/src/data/memory.ts` — roll up an explicit connector list.
- `packages/server/test/memory-overview.test.ts` — verify only supplied detected
  connectors render.
- `packages/shared/src/api.ts` — describe the filtered response accurately.
- `packages/web/src/pages/memory/MemoryPage.tsx` — align page-level documentation.

## Testing

- `npm test -- --run packages/server/test/memory-overview.test.ts`
- `npm test`
- `npm run typecheck`
- Review the response/UI behavior with only Claude Code and Codex source paths
  present: the grid contains exactly those two cards.

## Risks / open questions

- "Detected" means the configured transcript source path exists or the connector
  contributes an actual memory item. A CLI installed but never run and with no
  memory file will not appear, which is appropriate because ClaudeScope has
  nothing to read from it.
