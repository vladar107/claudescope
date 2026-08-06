# 0065 — Shared fallback-title selection

- **Status:** done
- **Date:** 2026-08-06
- **PR:** https://github.com/vladar107/claudescope/pull/86

## Context

Claude Code records `/clear` as a structured command turn with a user role. If
the resulting session has no stored `ai-title`, ClaudeScope's fallback-title
path currently ranks that earliest non-empty user event and derives the title
`clear` instead of continuing to the person's first real prompt.

The fallback itself is shared by all connectors, but its candidate-selection
query currently makes the decision too early and contains Codex-specific
bootstrap handling inline. The prior Codex fix established the desired rule:
preserve injected records in the transcript, but do not use them as fallback
titles.

## Goal

Choose fallback session titles from the first eligible human prompt for every
provider. A leading Claude `/clear` command must be skipped in favor of the next
real user message, without rewriting or hiding any transcript content.

## Decisions

- **Use one shared candidate-selection pipeline** — ordered user turns from any
  connector pass through the same eligibility check before a fallback title is
  chosen; selection continues when a candidate is synthetic or cleans to empty.
- **Recognize only complete reserved turn shapes** — skip well-formed structured
  command/system envelopes such as Claude's `<command-name>...</command-name>`
  record. Malformed or unfamiliar text remains eligible so ordinary user prose
  is not broadly classified as system input.
- **Keep provider-specific preprocessing narrow** — Codex AGENTS/environment
  bootstrap unwrapping remains conditional on the Codex connector, but runs
  inside the shared selection pipeline rather than determining the first row in
  SQL.
- **Preserve real stored titles and source fidelity** — connector-provided
  titles still win, and events remain unchanged for transcript rendering,
  Source mode, search, and export.
- **Rebuild persisted derived titles** — bump the schema version so existing
  `clear` fallback titles are recalculated after upgrade.

## Approach

1. Add focused, connector-neutral candidate eligibility to the title module.
   Keep the existing Codex bootstrap preprocessing in the candidate query so
   large instruction blobs are removed before text crosses the 4 KiB result
   boundary.
2. Fetch ordered user candidates for untitled sessions in bounded per-session
   batches and choose the first candidate accepted by the shared helper, rather
   than ranking a single row before eligibility is known.
3. Bump the derived index schema version.
4. Run focused checks with a synthetic Claude `/clear` turn followed by a real
   prompt, then run the existing tests, typecheck, build, and review the diff.

## Files affected

- `packages/server/src/data/title.ts` — shared candidate preprocessing,
  synthetic-turn eligibility, and title selection helpers.
- `packages/server/src/data/index.ts` — ordered fallback candidates and
  first-eligible selection across providers.
- `packages/server/src/db/schema.ts` — derived-data schema version bump.
- `docs/plans/README.md` — plan index entry.

## Testing

- Focused synthetic indexing check: `/clear` remained in `events`, while the
  following prompt became the derived session title.
- Focused existing tests: 3 files, 53 tests passed, covering title cleaning,
  Codex fallback behavior, stored Claude titles, and stale-title fallback.
- `npm test`: 62 files, 591 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Final diff review and `git diff --check`: passed.
- Do not add test files or test cases unless the maintainer explicitly requests
  them.

## Risks / open questions

- The eligibility recognizer must stay conservative: matching incomplete tags
  or arbitrary prose could skip a genuine first prompt.
- Fetching more than one candidate per untitled session adds bounded rebuild
  work; cap candidate text and stop selection as soon as a usable title is
  found.
