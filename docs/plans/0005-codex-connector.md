# 0005 — Codex connector (second agent)

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-09
- **PR:** `feat/codex-connector`

## Context

The `AgentConnector` seam (0004) was built so a second agent could plug in. This
adds **OpenAI Codex CLI** as that connector — the real validation of the port.
Codex stores sessions at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.

Unlike Claude's flat one-row-per-event JSONL, Codex spreads a session across
record types (verified against real rollouts): `session_meta` (id, cwd),
`turn_context` (model, per turn), `response_item` (the transcript), and
`event_msg/token_count` (per-turn usage). A per-row `read_ndjson` projection
can't reconstruct it.

## Goal

Index and render Codex sessions end-to-end (browse / search / analytics +
threaded session detail, with OpenAI pricing), reusing 0004's canonical schema,
cost, FTS, and thread assembler — with **no impact on Claude's perf**.

## Decisions

- **TS-normalize → temp NDJSON → DuckDB.** Added an optional `prepare()` hook to
  the port: the Codex connector parses a rollout in TS into canonical event rows,
  writes a temp NDJSON under `~/.claudescope/cache/codex/`, and its
  `eventsProjectionSql` reads that 1:1. Claude is untouched (no `prepare`), so the
  hot path stays native and the perf gate is unaffected by construction.
- **Token mapping:** from `token_count.info.last_token_usage` →
  `cache_read = cached_input_tokens`, `input = input_tokens − cached`, `output =
  output_tokens` (already includes reasoning), `cache_write = 0`. Attributed to
  the assistant turn the token_count follows (per-session totals exact).
- **Transcript mapping:** `message`(input/output_text) → user/assistant turns;
  `reasoning`(encrypted_content) → signature-only thinking block; `function_call`
  + `function_call_output` → tool_use/tool_result paired by `call_id`;
  `developer` messages dropped. Synthetic `uuid`/`parentUuid` by order. No
  subagents. The existing `assembleThread`/`buildSubagentRuns` are reused.
- **Schema migration:** wired the dormant `SCHEMA_VERSION` (2 → 3) — added a
  `meta(schema_version)` table; a version mismatch discards+rebuilds the index (a
  derived cache). Added `files.connector_id` for session→connector dispatch.

## Files

- `src/connectors/types.ts` — added `prepare?()`.
- `src/connectors/codex/normalize.ts`, `src/connectors/codex/codex.ts` — new.
- `src/connectors/registry.ts` — register `codex`; `connectorById`.
- `src/data/index.ts` — call `prepare()`; write `connector_id`.
- `src/data/session-loader.ts` — dispatch by `connector_id`.
- `src/db/schema.ts`, `src/db/duckdb.ts` — `connector_id`, `meta`, version gate.
- `src/config.ts` — `CODEX_SESSIONS_DIR`.
- `packages/server/pricing.json` — OpenAI rates (gpt-5 / 5.4 / 5.5 + `gpt` family).
- `packages/server/test/codex.integration.test.ts` — new; `api.integration.test.ts`
  isolates `CODEX_SESSIONS_DIR`; `perf/run.ts` likewise.

## Testing / outcomes

- `npm run typecheck` ✓; `npm test` ✓ — 74 tests (69 Claude unchanged + 5 Codex).
- **Real data:** indexed the local `~/.codex/sessions` (2 rollouts) — sessions
  surfaced with correct model (gpt-5.4 / gpt-5.5), tool counts, tokens, and cost
  ($1.83 / $0.9986); detail thread normalized to text/thinking/tool_use/tool_result.
- **Perf:** Claude path byte-identical; bench corpus isolated from real `~/.codex`;
  headline metrics unchanged. PR `perf.yml` A/B enforces ≤20%.

## Risks / follow-ups

- Per-message token attribution is heuristic (session totals exact).
- OpenAI pricing is best-effort + user-editable (verified June 2026 rates).
- UI renders Codex tools/reasoning via the generic blocks; a Codex-specific
  polish pass (surfacing reasoning summaries, exec output) is a follow-up.
- Temp NDJSON cache under `~/.claudescope/cache/codex/` is overwritten per change;
  stale entries are harmless.
