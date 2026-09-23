# 0091 — Codex guardian review usage

- **Status:** done
- **Date:** 2026-09-23
- **PR:** https://github.com/vladar107/claudescope/pull/120

## Context

Plan [0072](./0072-hide-codex-guardian-sessions.md) made Codex's internal
"guardian" approval-review rollouts (`session_meta.payload.source.subagent.other:
"guardian"`) disappear entirely — `normalize.ts`'s `parseRollout` returns null for
them, so no session, thread, subagent run, search hit, or title is ever built from
one. That was the right call for visibility: a guardian's synthetic review
transcript isn't something a user asked for or should browse. But returning null
also discarded the real token usage those reviews bill, so a session's reported
cost and token totals undercounted whenever Codex ran a guardian review against it
(GitHub issue #117, part 2).

Real-data audit (62 guardian rollouts, Codex 0.145–0.154) established the shape
needed to recover the usage safely:

- `session_meta.payload` carries a TOP-LEVEL `parent_thread_id` (and
  `session_id`) naming the parent thread — always present. This is a different
  location than an ordinary subagent's parent link
  (`source.subagent.thread_spawn.parent_thread_id`), and there is no
  `thread_spawn` on a guardian rollout, nor a spawn call in the parent for it.
- Records present: `turn_context` (model is always `codex-auto-review`),
  `event_msg/token_count` (usage, same shape as an ordinary rollout's), plus
  messages/reasoning that are still discarded.
- `codex-auto-review` is a backend alias with no knowable client-side rate.

## Goal

Guardian review usage counts toward its parent session's tokens and cost, priced
at a real model, while the guardian rollout itself remains completely invisible
(no session, no thread, no run, no title, no search hit) — plan 0072's visibility
guarantee is preserved; only the cost undercount it introduced is fixed.

## Decisions

- **Usage-only rows, not visible content.** A guardian rollout is normalized to
  one canonical `events` row per billed `token_count`, with empty content
  (no text/tool/thinking blocks), `is_sidechain: true`, and `session_id` re-keyed
  to the ROOT thread via the existing `rootThreadId`/`getCodexContext().parents`
  machinery. `loadSession` (the detail-view read) still calls `parseRollout`,
  which still returns null for a guardian file — so it never becomes a
  `SubagentSource`, never enters `mainEvents`, and plan 0072's guarantees hold
  unchanged. The usage-only rows exist purely in the `events` index, built by a
  new, separate `parseGuardianRollout`.
- **Price at the parent thread's model, not `codex-auto-review`.** Each usage row
  is priced at the parent's `turn_context.payload.model` last set at or before
  the row's own timestamp (falling back to the parent's first recorded model, or
  to no override at all if the parent rollout can't be read). This is a new
  generic, nullable `events.pricing_model` column — `COALESCE(pricing_model,
  model)` is what the cost expression rates against — not a Codex-specific
  branch in `data/`. Every other connector emits it as null (or omits it, which
  reads back as null the same way `provider` already does).
- **Exclude usage-only rows via an explicit flag, not a content-shape guess.**
  `sessions.message_count` and `has_sidechain` previously counted every `events`
  row for a session unconditionally. A guardian row is a real `events` row (so
  its cost/tokens count), but it isn't a turn a reader would ever see, so it must
  not inflate "N messages" or flip on the "N subagents" chip with nothing for it
  to point at. The first cut of this exclusion was content-shaped (no text, no
  tool call) — but on the real index that matched 4,592 genuine Claude Code
  split-message rows (a thinking-only block with no text/tool, signature-only
  by design) and 12 genuine Codex rows, none of them guardian usage, silently
  dropping them from `message_count`. Replaced with a new nullable
  `events.usage_only BOOLEAN DEFAULT FALSE` canonical column, set TRUE only by
  `parseGuardianRollout`; every other row (real or synthetic) is FALSE. This is
  still generic — the column exists for any future usage-only row, not just
  Codex's — but it is a fact a connector states about the row it built, never
  inferred from its shape.
- **No second directory walk.** The parent rollout's file path is resolved from
  the SAME first-line read `getCodexContext()` already does for the whole
  sessions dir per pass (extended to record every rollout's `id → path`, not
  only subagents' `parent`). The parent's full `turn_context` timeline is then
  read once per PARENT PATH per pass (memoized), since multiple guardian
  rollouts commonly share one parent.
- **Bump `SCHEMA_VERSION`.** Existing indexes hold pre-fix guardian-omitted data
  and a schema missing `pricing_model`; both need a rebuild.
- **Bill a re-emitted `token_count` once (separate commit).** Codex sometimes
  repeats a snapshot whose running `total_token_usage` has not moved; summing
  its `last_token_usage` double-counted that call (139 of 7,094 local snapshots,
  9.5M input tokens). Both the session and guardian paths skip such a repeat.

## Approach

1. Add nullable `pricing_model VARCHAR` and `usage_only BOOLEAN DEFAULT FALSE`
   to `connectors/canonical.ts` (`CANONICAL_COLUMNS` + `CanonicalRow`) and the
   `events` DDL in `db/schema.ts`. `canonicalProjectionSql` coalesces
   `usage_only` to FALSE on read (most connectors never set it); the Claude
   Code raw projection emits `FALSE AS usage_only` explicitly, since it doesn't
   go through `canonicalProjectionSql` at all.
2. `data/index.ts`: `buildCostExpr`'s exact-id join and family LIKE match, and
   `loadFile`'s `pricing_rates` LEFT JOIN, all key off
   `COALESCE(ev.pricing_model, ev.model)` instead of `ev.model` alone.
3. `data/index.ts`: filter `sessions.message_count` (`FILTER (WHERE NOT
   usage_only)`) and `has_sidechain` (`bool_or(is_sidechain AND NOT
   usage_only)`) on the new flag.
4. `codex/normalize.ts`: extend `CodexContext` with a `paths` map (built from the
   existing per-file first-line read); add a per-pass, per-parent-path memoized
   `parentModelTimeline`/`parentModelAt`; add `parseGuardianRollout`, which
   re-parses a guardian rollout's `event_msg/token_count` records into
   content-empty, `usage_only: true` `CanonicalRow`s re-keyed to the root
   parent thread and priced via `pricing_model`. `parseRollout` itself is
   unchanged.
5. `codex/codex.ts`: `prepare()` falls back to `parseGuardianRollout` when
   `parseRollout` returns null. `loadSession` is unchanged — it already excludes
   a guardian file from both `mainEvents` and `subagents` because `parseRollout`
   still returns null for it.
6. Bump `SCHEMA_VERSION`; update the `normalize.ts` header comment and this plan;
   plan 0072 is referenced as partially superseded (visibility stays hidden,
   usage is now counted).
7. Extend `codex.integration.test.ts`'s guardian fixtures with a linked-to-a-
   real-parent case (priced at the parent's distinct rate) and a
   missing-parent case (priced via its own default/family chain), replacing the
   two content-only fixtures plan 0072 added.

## Files affected

- `packages/server/src/connectors/canonical.ts` — `pricing_model` and
  `usage_only` columns; `usage_only` coalesced to FALSE on read.
- `packages/server/src/db/schema.ts` — `events.pricing_model` /
  `events.usage_only` DDL, `SCHEMA_VERSION` bump.
- `packages/server/src/data/index.ts` — cost expression + pricing join keyed off
  `COALESCE(pricing_model, model)`; `message_count`/`has_sidechain` filtered on
  `NOT usage_only`.
- `packages/server/src/connectors/claude-code/claude-code.ts` — emits
  `pricing_model` as a NULL literal and `usage_only` as `FALSE` (it never sets
  either).
- `packages/server/src/connectors/codex/normalize.ts` — `CodexContext.paths`,
  `parentModelTimeline`/`parentModelAt`, `parseGuardianRollout`; header comment.
- `packages/server/src/connectors/codex/codex.ts` — `prepare()` falls back to
  `parseGuardianRollout`.
- `packages/server/test/codex.integration.test.ts` — linked/orphaned guardian
  fixtures and coverage, a thinking-only regression fixture, and a
  model-switch fixture for `parentModelAt`.
- `docs/plans/0091-codex-guardian-usage.md`, `docs/plans/README.md` — this plan.

## Testing

- `npm test` (full suite, including `architecture-rules.test.ts` and
  `connector-error-signal.test.ts`) and `npm run typecheck`.
- `codex.integration.test.ts`: a guardian linked to `codex-sess-1` contributes
  usage priced at `codex-sess-1`'s `gpt-5.4` rate (a rate distinct from the
  shipped default), the parent session's title/subagent-run count/message count
  are unchanged, and the guardian id itself is absent from `/api/sessions` and
  404s on detail. A guardian whose parent rollout was never written re-keys to
  the absent parent id, contributes zero messages and `hasSidechain: false`, and
  prices via its own model chain (the shipped default, since `codex-auto-review`
  matches no pricing family). A dedicated regression fixture asserts a genuine
  reasoning-only turn (no text, no tool call — the exact shape `usage_only`
  replaces a content-shape guess for) still counts toward `message_count`. A
  parent with two `turn_context` records and a guardian review timestamped
  after the switch prices at the SECOND model, proving `parentModelAt` walks to
  the latest preceding record rather than the parent's first one.

## Risks / open questions

- **Staleness across files.** A guardian's price depends on its PARENT file's
  `turn_context` history. `files` change-detection is per file, so rewriting the
  parent doesn't touch the guardian's own mtime and won't re-trigger its
  `prepare()`. This is acceptable: the parent's *past* `turn_context` records
  (the ones at or before the guardian's own timestamp) never change once
  written, so a stale guardian re-normalization can't actually mis-price against
  them. A parent rollout appearing for the first time AFTER an orphaned guardian
  was already indexed is the one case that stays stale until something else
  touches the guardian file (or a full rebuild).
- **`codex-auto-review`'s pricing-family exposure.** Should its own rate ever
  become knowable (a future LiteLLM entry), the model-chain fallback for an
  orphaned guardian would price against it instead of the default — a pricing
  change, not a correctness issue, and prospective only (per the existing
  cost-is-stamped-at-index-time rule).
