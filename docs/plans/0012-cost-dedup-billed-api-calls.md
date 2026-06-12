# 0012 — Cost dedup: billed API calls

- **Status:** done
- **Date:** 2026-06-12
- **PR:** [#16](https://github.com/vladar107/claudescope/pull/16)

## Context

The indexer sums `message.usage` over every assistant event row, but one billed
API call appears as multiple rows. Two mechanisms, verified empirically on real
data (2026-06-12):

1. **Multi-block splits** — Claude Code writes one JSONL line per content block
   of a single API response, each line repeating the same `message.id` and the
   full `usage`. In ~1,800 such groups the earlier lines carry partial
   `output_tokens` (streaming progress); the max-output row is the true one.
2. **Fork/resume copies** — branching copies the whole session history into the
   new session file with `sessionId` rewritten (uuid/message.id/usage/timestamps
   preserved). Each copied line is stamped with a top-level
   `forkedFrom: {sessionId, messageUuid}` marker (legacy forks may lack it).

Measured inflation on the author's corpus: 23,714 assistant rows vs 10,999
billed calls; output tokens ×3.0, cache-read ×2.3.

Codex is unaffected (usage accumulated from per-call `token_count` deltas, once
per turn; no cross-file copies observed). Junie is unaffected (per-turn
`LlmResponseMetadataEvent` sums; apparent duplicates are distinct tiny helper
calls with identical usage).

## Goal

Eliminate double-counting so that all usage and cost aggregates count each billed
API call exactly once, while leaving raw event data and the thread view untouched.

## Decisions

- **Dedup key: `message.id`** — unique per billed call on the verified corpus;
  connector-agnostic column so other connectors can populate it later. `requestId`
  is not stored (not needed).
- **`usage_canonical` flag on `events`, not a separate table** — raw rows stay
  untouched; the flag is re-elected globally on every reindex that changed files.
  Simpler than a join table; analytics queries just add a `WHERE usage_canonical`.
- **Election per `message_id` partition** — ORDER BY:
  (1) `forked_from_session_id IS NOT NULL ASC` (original session beats fork copies,
  exact attribution via the `forkedFrom` marker);
  (2) `output_tokens DESC` (final streaming row beats partials);
  (3) `file_path`, `uuid` (deterministic fallback for legacy forks — totals are
  exact regardless of which copy wins). `NULL message_id` rows are always canonical.
- **If the original file is deleted** the fork's copy is elected and cost
  re-attaches there. No data is lost.
- **Message/tool counts and FTS are unfiltered** — content blocks are not
  duplicated, only usage is.
- **Analytics `messageCount` becomes deduped billed-call count** — intentional
  semantic change; more useful than raw row count.
- **SCHEMA\_VERSION 5→6** — the index is a derived cache; it is discarded and
  rebuilt on first run after upgrade.

## Approach

1. **Schema.** Add `message_id`, `forked_from_session_id`, `usage_canonical`
   columns to `events`; bump `SCHEMA_VERSION` to 6.
2. **Claude Code connector.** Extract `message.id` and `forkedFrom.sessionId`
   from each assistant event row.
3. **Codex + Junie connectors.** Emit `NULL` for both new columns (no change to
   their dedup logic).
4. **`electCanonicalUsage`.** New function in `data/index.ts`: after a reindex
   pass that changed anything, run a global DuckDB UPDATE that re-elects
   `usage_canonical` via the election window described above (a full recompute,
   cheap at this scale — stays correct across added/edited/removed files).
5. **Filtered sums.** `rebuildSessions` and `/api/analytics` apply
   `FILTER (WHERE usage_canonical)` to all `SUM(input_tokens)` /
   `SUM(output_tokens)` / `SUM(cache_*)` / `SUM(cost)` aggregates. The sessions
   `message_count` stays unfiltered (it counts transcript rows); only the
   analytics `messageCount` is deduped (it counts billed calls).
6. **Integration test.** New `packages/server/test/dedup.integration.test.ts`
   covering: multi-block split, partial-output rows, marked fork pair, legacy
   unmarked fork.

## Files affected

- `packages/server/src/db/schema.ts` — add `message_id`, `forked_from_session_id`,
  `usage_canonical`; bump `SCHEMA_VERSION` to 6.
- `packages/server/src/connectors/claude-code/claude-code.ts` — project
  `message.id` and `forkedFrom.sessionId` per event row.
- `packages/server/src/connectors/codex/codex.ts` — emit `NULL` for new columns.
- `packages/server/src/connectors/junie/junie.ts` — emit `NULL` for new columns.
- `packages/server/src/data/index.ts` — add `electCanonicalUsage`; filter all
  usage/cost sums on `usage_canonical` in `rebuildSessions`.
- `packages/server/src/routes/analytics.ts` — filter all usage/cost sums on
  `usage_canonical`.
- `packages/server/test/dedup.integration.test.ts` — new integration test.

## Testing

- Integration: `dedup.integration.test.ts` builds a real DuckDB index from
  synthetic JSONL fixtures in a temp dir; asserts canonical row counts and token
  totals for each dedup scenario. Never touches real `~/.claude*` dirs.
- `npm test` and `npm run typecheck` green after the change.

## Risks / open questions

- Legacy forks without the `forkedFrom` marker fall back to
  `file_path`/`uuid` ordering — totals remain exact, attribution may land on the
  fork copy rather than the original. Acceptable given the rarity and the fallback
  logic.
- Codex fork support is out of scope; if Codex ever copies `token_count` lines,
  its connector can populate `message_id` and gain dedup for free.
- Per-bubble token chips in the thread view still show each raw row's usage
  (unfiltered). Addressed separately if wanted.
