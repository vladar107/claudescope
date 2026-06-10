# 0010 — Runtime pricing refresh from LiteLLM

- **Status:** in-progress
- **Date:** 2026-06-10
- **PR:** <link, once opened>

## Context

Model prices change and new models appear far more often than claudescope
releases. Today the only rate source is the shipped `pricing.json`, seeded once
into `~/.claudescope/pricing.json` and never refreshed — so existing installs
estimate costs with stale rates, and any model missing from the file silently
falls back to family/default rates. The maintainer-side
`scripts/update-pricing.mjs` scrapes Anthropic's docs page (Claude only,
fragile HTML parse) and requires a release to reach users. Junie sessions can
additionally run on non-Anthropic/non-OpenAI providers (e.g. Gemini), which
today always fall to the default rate.

## Goal

Decouple pricing from releases: the app fetches current rates at runtime from
LiteLLM's community-maintained pricing JSON, refreshes them automatically while
the daemon runs, and exposes a manual `claudescope pricing update` CLI command.
Historical (already-indexed) costs stay as-is.

## Decisions

- **Source: LiteLLM `model_prices_and_context_window.json`** (raw GitHub, no
  auth) — machine-readable, covers all major providers, updated within days of
  new models. Rejected: scraping Anthropic docs at runtime (fragile, breaks for
  all users at once, Claude-only); hosting a curated file in this repo (still
  needs the maintainer to notice price changes).
- **Provider allowlist, not the full file** — keep models whose
  `litellm_provider` ∈ {anthropic, openai, gemini, xai, mistral, deepseek} and
  `mode === "chat"` (~500–800 models), skipping Bedrock/Azure/Vertex duplicates
  and non-chat models that bare transcript model ids would never match.
- **Latest snapshot only, stored as a file** — `~/.claudescope/pricing.fetched.json`
  (`{ fetchedAt, models }`). Not in DuckDB: the index is a disposable derived
  cache and pricing must survive rebuilds. No rate history: LiteLLM has none,
  and per-event costs are already frozen at index time.
- **Precedence: fetched exact id → local exact id → local family substring →
  local default.** Implemented as a per-model merge (`fetched.models` over
  `local.models`); `families`/`default` always come from the local file
  (LiteLLM has no such concepts). The shipped default remains the bottom
  fallback when no files exist.
- **mtime-keyed `loadPricing()` cache instead of an API endpoint** — the CLI
  command and the daemon timer both just write the file; the daemon picks up
  changes on its next reindex poll (≤15 s). Rejected: a `POST /api/pricing/
  refresh` endpoint + CLI→daemon plumbing (more moving parts for the same
  outcome).
- **Cost via a DuckDB pricing join table** — at ~800 models the current inline
  `CASE` in `buildCostExpr` becomes a multi-thousand-branch expression; a small
  pricing table joined at projection time (exact id → family → default
  fallback) is the clean shape. Persisted-cost semantics are unchanged.
- **Fail-safe refresh** — validate everything parsed (finite, ≥ 0, sanity cap,
  ≥ 1 anthropic + ≥ 1 openai model); on any failure abort without writing and
  keep last-known rates. Failures log at warn level (daemon) / stderr (CLI).
- **Accepted imprecision** — refreshed rates apply to newly indexed events
  only; a full index rebuild re-prices history at current rates. Costs are
  estimates by design.

## Approach

1. **Wave 1 — refresh core.** Shared `FetchedPricing` type; config constants
   (`FETCHED_PRICING_PATH`, `PRICING_REFRESH_INTERVAL_MS`,
   `LITELLM_PRICING_URL`, provider allowlist); new
   `packages/server/src/data/pricing-refresh.ts` with a pure
   `mapLiteLLM(json)` (per-token → per-MTok, missing cache fields → 0) and
   `refreshPricing()` (fetch → map → validate → atomic write). Fixture-based
   unit tests, no network.
2. **Wave 2a — merge + server wiring.** `loadPricing()` merges shipped default
   ← user `pricing.json` ← `pricing.fetched.json` with an mtime-keyed cache;
   cost computation moves from the inline CASE to a pricing join table; server
   boot refreshes in the background when the snapshot is missing/stale (>24 h)
   plus a 24 h interval timer (unref + onClose cleanup, warn on failure —
   same pattern as auto-reindex).
3. **Wave 2b — CLI + docs.** `claudescope pricing update` (direct in-process
   fetch; prints model count, fetchedAt, path, changed-rate count); help text;
   `gemini` family added to the shipped `pricing.json`; README + CLAUDE.md
   updates.
4. **Wrap-up.** Review, `npm test`, `npm run typecheck`.

## Files affected

- `packages/shared/src/pricing.ts` — add `FetchedPricing` type.
- `packages/server/src/config.ts` — fetched-pricing path, refresh interval,
  LiteLLM URL, provider allowlist.
- `packages/server/src/data/pricing-refresh.ts` — new: fetch/map/validate/write.
- `packages/server/src/data/pricing.ts` — layered merge + mtime-keyed cache.
- `packages/server/src/data/index.ts` — pricing join table replaces the inline
  cost CASE.
- `packages/server/src/index.ts` — boot-time + interval auto-refresh.
- `packages/server/src/cli.ts` — `pricing update` command + help.
- `packages/server/pricing.json` — add `gemini` family rates.
- `packages/server/test/` — mapper unit tests; merge/invalidation tests.
- `README.md`, `CLAUDE.md` — document the fetched layer and the command.

## Testing

- Unit: `mapLiteLLM` against an inline LiteLLM-shaped fixture (happy path,
  malformed entries skipped, validation aborts, per-token → per-MTok math).
- Unit/integration: `loadPricing` precedence and mtime invalidation via
  temp-dir `PRICING_PATH`/`FETCHED_PRICING_PATH`; cost join produces the same
  values the CASE did for exact/family/default matches.
- `npm test` and `npm run typecheck` green; no test touches the network or
  real `~/.claude*` dirs.

## Risks / open questions

- LiteLLM schema drift breaks the mapper → strict validation + abort-without-
  write; users keep last-known rates indefinitely (warn log). Worst case
  equals today's behavior.
- LiteLLM rates can lag or differ from official pricing — accepted; costs are
  local estimates.
- `scripts/update-pricing.mjs` stays as maintainer tooling for the shipped
  fallback file; could later be replaced by the same LiteLLM mapper
  (follow-up).
