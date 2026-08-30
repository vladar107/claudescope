# 0077 — Restore Codex file-change detection

- **Status:** done
- **Date:** 2026-08-30
- **PR:** https://github.com/vladar107/claudescope/pull/99

## Context

ClaudeScope already converts a direct Codex `custom_tool_call` named
`apply_patch` into canonical `Write`/`Edit`/`MultiEdit` blocks. The shared
changeset collector and index-time `file_edits` extraction then provide the web
Files changed view and impact analytics.

Current Codex rollouts instead expose one outer `custom_tool_call` named `exec`.
Its JavaScript input invokes a nested tool using the generated form
`const patch = "..."; text(await tools.apply_patch(patch));`. The normalizer
treats the outer call as an opaque `exec`, so none of the existing patch fan-out
is reached. A sampled real session contains nine successful nested patches but
currently reports zero changed files.

This work is intentionally separate from Codex session-title and guardian
handling. It will use branch `fix/codex-nested-file-changes` and its own PR.

## Goal

Recover statically expressed nested Codex `apply_patch` calls and feed them
through the existing canonical edit pipeline, so successful edits appear in
Files changed and indexed impact data while failed, ambiguous, and unrelated
`exec` calls remain raw.

## Decisions

- **Never evaluate rollout JavaScript** — use a small dependency-free lexical
  extractor that ignores strings/comments while locating the actual
  `tools.apply_patch(...)` invocation. Decode only a direct string literal or a
  local identifier bound to one static string literal.
- **Fail closed on ambiguity** — interpolation, dynamic expressions,
  concatenation, computed property access, multiple patch invocations, malformed
  JavaScript, or an invalid V4A envelope remain an ordinary `exec` block.
- **Reuse the existing patch pipeline** — recovered patch text goes through the
  current V4A parser, per-file fan-out, canonical tool names, and per-file status
  helpers. The shared changeset/UI/index APIs do not change.
- **Require a successful outer result** — nested edit blocks are provisional
  until the paired wrapper output explicitly succeeds or matches the observed
  `Script completed` envelope. Explicit errors, failed/unrecognized envelopes,
  and missing results demote back to the original raw `exec`, preserving the
  complete failure text and exposing no `file_path`.
- **Keep legacy behavior** — direct `apply_patch` rollouts and their existing
  success/failure envelopes continue to normalize byte-for-byte as before.
- **No new dependency** — the published bundle remains self-contained apart
  from its existing DuckDB runtime dependency.
- **Rebuild derived data once** — advance to schema v18 after plan 0076's v17
  rebuild so unchanged Codex files are re-normalized and `file_edits` is
  repopulated.

## Approach

1. Add a narrow static extractor for the observed direct-literal and
   constant-binding `tools.apply_patch` forms, including escaped quotes and
   newlines, with explicit rejection of dynamic or multiple-call programs.
2. Feed a recovered V4A patch through the existing per-file fan-out while
   retaining the outer tool name/input needed for raw fallback.
3. Decode the current array-shaped wrapper output, recognize explicit
   success/failure, attach concise per-file results on success, and demote
   failed, unconfirmed, or incomplete calls before normalized events are final.
4. Advance the derived schema version so existing indexes and normalized Codex
   cache entries rebuild from unchanged source rollouts.
5. Extend existing Codex and file-edit integration coverage for single/multi-
   file edits, escaped static strings, rejected patches, unrelated `exec`
   commands containing patch-like text, malformed/dynamic programs, and indexed
   path/addition/deletion results.
6. Run focused and full validation, then use an isolated index plus read-only
   comparison against an affected real session to confirm its changed files are
   recovered.

## Files affected

- `packages/server/src/connectors/codex/normalize.ts` — statically recover nested
  patch payloads, gate fan-out on the paired wrapper result, and preserve raw
  fallback behavior.
- `packages/server/src/db/schema.ts` — invalidate unchanged normalized rows and
  stale `file_edits`.
- `packages/server/test/codex.integration.test.ts` — current wrapper parsing,
  rendering, success/failure, and fail-closed regression cases.
- `packages/server/test/file-edits.integration.test.ts` — indexed edit paths and
  line statistics for successful nested patches only.
- `CLAUDE.md` — document both direct and current nested Codex patch forms.
- `docs/plans/0077-restore-codex-file-change-detection.md` — this plan.
- `docs/plans/README.md` — plan index entry.

## Testing

- Focused:
  `npx vitest run packages/server/test/codex.integration.test.ts packages/server/test/file-edits.integration.test.ts`
- Full: `npm test`
- Types: `npm run typecheck`
- Production build: `npm run build`
- Hygiene: `git diff --check`
- End-to-end: use the repository `verify` skill with sandboxed fixtures, then
  perform read-only checks against an affected session. Never write to real
  agent sources or `~/.claudescope`.

## Risks / open questions

- The wrapper is implementation detail and may change again. Unknown programs
  deliberately remain raw rather than guessing or reporting false edits.
- A naive substring/regex search would misclassify commands that merely inspect
  the text `tools.apply_patch`; lexical recognition must distinguish executable
  syntax from strings and comments.
- The outer wrapper currently supplies an explicit success signal and a
  `Script completed` envelope. If future records omit both, edits stay raw until
  that result contract is understood.
- Plan 0076 merged first. This branch was then rebased onto it, retaining both
  normalizer/test changes and advancing the derived schema from v17 to v18.
