# 0076 — Restore Codex session naming

- **Status:** done
- **Date:** 2026-08-30
- **PR:** https://github.com/vladar107/claudescope/pull/98

## Context

Codex still has no stored session title, so ClaudeScope derives one from the
first genuine user prompt. The bootstrap recognizer currently requires the
older heading `# AGENTS.md instructions for <path>`. Current rollouts can use
`# AGENTS.md instructions` without a path; that wrapper is not stripped and
recent sessions are consequently titled `AGENTS.md instructions`.

The same format generation changed guardian approval-review metadata from
`thread_source: "subagent"` to `thread_source: "guardian_review"` while retaining
`source.subagent.other: "guardian"`. The current compound check misses those
rollouts, so synthetic guardian reviews reappear as top-level sessions with
prompt-like fallback titles.

This work is intentionally separate from Codex tool/file-change normalization.
It will use branch `fix/codex-session-names` and its own PR.

## Goal

Derive Codex session names from the first genuine user prompt for both observed
bootstrap-heading variants, and exclude both legacy and current guardian review
rollouts without changing transcript fidelity or normal subagent behavior.

## Decisions

- **Recognize only complete known bootstrap shapes** — accept the exact
  `# AGENTS.md instructions` heading with an optional `for <path>` suffix only
  when the expected instructions/environment envelopes are well formed. Do not
  broadly classify arbitrary headings containing “instructions” as bootstrap.
- **Keep title cleanup and candidate selection aligned** — update both the
  injected-line cleaner and Codex-specific pre-ranking wrapper removal so a
  bootstrap-only event is skipped and a coalesced real prompt remains eligible.
- **Treat the guardian source marker as authoritative** —
  `source.subagent.other: "guardian"` is stable across both observed
  `thread_source` values. Filter on that structural marker instead of coupling
  the exclusion to one generation's thread-source label.
- **Preserve source records** — title logic changes only the derived title;
  guardian filtering happens at normalization. No source transcript is edited.
- **Rebuild derived data once** — advance to the next available schema version
  at merge time so unchanged rollouts are re-normalized and stale titles and
  guardian rows disappear.

## Approach

1. Broaden the exact Codex bootstrap-heading recognition in the fallback-title
   cleaner and SQL candidate preprocessing while retaining complete-envelope
   and malformed-input safeguards.
2. Update Codex normalization to exclude a rollout whenever its structural
   source metadata identifies it as a guardian, covering both legacy and
   `guardian_review` records.
3. Advance the derived schema version so installed indexes rebuild from source.
4. Extend the existing focused title and Codex integration tests for the
   pathless header, bootstrap-only and coalesced prompt forms, current guardian
   metadata, and preservation of ordinary top-level/subagent sessions.
5. Run focused and full validation, then verify the affected real-data shapes
   read-only through an isolated ClaudeScope fixture/index.

## Files affected

- `packages/server/src/data/title.ts` — recognize the exact pathless Codex
  bootstrap heading as injected context.
- `packages/server/src/data/index.ts` — strip both complete Codex bootstrap
  variants before ranking fallback-title candidates.
- `packages/server/src/connectors/codex/normalize.ts` — exclude legacy and
  current guardian review rollouts by their structural source marker.
- `packages/server/src/db/schema.ts` — invalidate stale derived titles and
  guardian rows.
- `packages/server/test/title.test.ts` — focused heading-cleanup cases.
- `packages/server/test/codex.integration.test.ts` — end-to-end title and
  guardian-filter regression cases.
- `docs/plans/0076-restore-codex-session-naming.md` — this plan.
- `docs/plans/README.md` — plan index entry.

## Testing

- Focused:
  `npx vitest run packages/server/test/title.test.ts packages/server/test/codex.integration.test.ts`
- Full: `npm test`
- Types: `npm run typecheck`
- Production build: `npm run build`
- Hygiene: `git diff --check`
- Isolated verification: confirm affected sessions derive their genuine prompt
  as the title, guardian IDs are absent, and normal Codex sessions/subagents
  remain present. Never write to real Codex sources or `~/.claudescope`.

## Risks / open questions

- An overly loose heading match could hide genuine user prose. Requiring the
  reserved first-line heading plus complete wrapper boundaries keeps the match
  fail-closed.
- This branch and plan 0077 both touch the Codex normalizer, schema version,
  Codex integration fixture, and plan index. Implementation can proceed in
  parallel worktrees, but the second PR to merge must rebase, resolve those
  narrow overlaps, and advance the schema version again. Intended merge order:
  plan 0076 first, then plan 0077.
