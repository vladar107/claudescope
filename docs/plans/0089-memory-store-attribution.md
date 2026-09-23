# 0089 — Memory store attribution

- **Status:** done
- **Date:** 2026-09-23
- **PR:** https://github.com/vladar107/claudescope/pull/118

## Context

`collectMemory()` (`packages/server/src/data/memory.ts`) attributes each Claude
Code project-memory fact to a project via `byOrigin ?? fallback` — the project
of the fact's `originSessionId` wins over the project that owns the memory dir
(`fallback`, from the dir slug via `slugToProject`). Claude Code keys a memory
dir by the git repo root and loads it in every subdir/worktree/submodule of that
repo, so origin-first attribution splits ONE store into several project entries:
a real report (issue #116) showed 27 facts under the parent project and 3 under
a submodule project that has no memory dir of its own. The same split hits
`claudescope search --scope memory` (`routes/search.ts` calls `collectMemory`
too).

This reverses the origin-first decision made in plan 0014 ("attach each fact to
the project of its `originSessionId`, falling back to the dir slug"). That
design under-weighted how memory dirs are actually keyed: Claude Code writes to
one dir per git repo root regardless of which worktree/subdir/submodule the
session ran in, so the dir — not any individual fact's origin — is the real unit
of storage. Origin-first was right for individual facts in isolation but wrong
for the physical store, which is what a user actually browses.

## Goal

A memory dir surfaces as ONE project's worth of facts — the project that owns
the dir — so a git repo with worktrees/submodules doesn't fragment into several
partial project entries. `originSessionId` stays on each source as secondary
metadata (the web card already deep-links it), and still resolves the rare case
where the dir's own slug isn't an indexed project at all.

## Decisions

- **Store-first, origin as dir-level fallback only** — `projectId = storeProject
  ?? majorityOriginProject(dir.facts)`, computed ONCE per dir, not per fact.
  Rejected: keeping origin-first with a UI-side "merge worktree projects"
  step — that only papers over the list/card views and leaves the CLI/MCP
  `search --scope memory` output and `/api/projects/:id/memory` still split.
- **Majority vote, not "first fact wins"** — when the dir's slug matches no
  indexed project (no session ever ran exactly at the repo root), the whole dir
  goes to whichever project its facts most often originate from. Ties break
  deterministically (count desc, then `projectId` asc) so output doesn't depend
  on map iteration order. Rejected: picking the first fact's origin — order is
  an implementation detail of `readdirSync`, not a meaningful signal.
- **Drop unchanged** — a dir whose slug matches no project AND whose facts have
  no resolvable origin either is still dropped entirely, as before. There is no
  project to attach it to.
- **`originSessionId` stays put** — no change to what's stored on each
  `MemorySource`; only how the ROUTE groups sources into projects changes.

## Approach

1. `data/memory.ts`: replace the per-fact `byOrigin ?? fallback` with a
   per-dir `storeProject ?? majorityOriginProject(dir.facts, sessionToProject)`,
   computed before the facts loop so every fact in a dir gets the same
   `projectId`.
2. Add `majorityOriginProject()`: tallies `sessionToProject` hits across a
   dir's facts, returns the top project id (deterministic tie-break), or
   `undefined` when nothing resolves.
3. Update the doc comments describing origin-first attribution: the header of
   `data/memory.ts`, `connectors/types.ts` (`projectMemory` doc and
   `AgentMemoryDir` doc), and `connectors/claude-code/memory.ts` (module header
   and `projectMemory()` doc).
4. Add an integration test that builds a real DuckDB index from synthetic
   Claude Code session + memory-dir fixtures in a temp dir, covering: a
   parent-repo dir whose facts include one written from a submodule session
   (all facts must land on the parent project); an unmatched-slug dir with a
   majority origin (whole dir goes to the majority project, not split); and the
   unresolvable case (dir dropped).

## Files affected

- `packages/server/src/data/memory.ts` — store-first attribution +
  `majorityOriginProject()`; header comment.
- `packages/server/src/connectors/types.ts` — `projectMemory` and
  `AgentMemoryDir` doc comments.
- `packages/server/src/connectors/claude-code/memory.ts` — module header and
  `projectMemory()` doc comment.
- `packages/server/test/memory-attribution.integration.test.ts` — new
  integration test (parent/submodule split, majority-vote fallback, drop case).

## Testing

- `npm run typecheck` — passes.
- `npm test` — 85 files / 878 tests pass, including the two new cases in
  `memory-attribution.integration.test.ts`.
- Verified the new test fails against the pre-fix `collectMemory` (reverted the
  fix locally, reran — both assertions failed as expected — then restored it),
  confirming it actually catches the bug rather than passing vacuously.

## Risks / open questions

- None known. The change is scoped to attribution grouping; nothing about how
  facts are read, parsed, or rendered changes, and `originSessionId` is still
  exposed on every source.
