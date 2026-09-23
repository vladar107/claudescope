# 0090 — 1-hour cache-write pricing

- **Status:** done
- **Date:** 2026-09-23
- **PR:** https://github.com/vladar107/claudescope/pull/119

## Context

All cache-creation tokens are currently priced at one `cacheWrite` rate, which
models the 5-minute cache TTL (1.25x input on Anthropic's price list). Claude
Code writes most of its cache with the 1-hour TTL instead, billed at 2x input —
verified locally against real transcripts (e.g. one project wrote 8.1M 1h vs
1.7M 5m cache-write tokens over 30 days). The transcripts already carry the
split in `message.usage.cache_creation.ephemeral_1h_input_tokens` /
`ephemeral_5m_input_tokens`; LiteLLM (the runtime rates source) also publishes
the 1h rate as `cache_creation_input_token_cost_above_1hr`. Pricing every
cache write at the 5m rate under-costs any session that leans on the 1-hour
cache.

## Goal

Split `cache_write_tokens` into its 1h and 5m portions at cost time and price
each at its own rate, with the 1h rate optional per pricing entry (falling
back to 2x that entry's own `input` rate when unset) — without changing what
`cache_write_tokens` itself means (still the total, so token displays and the
cache-hit ratio are unaffected).

## Decisions

- **New canonical column `cache_write_1h_tokens`, `cache_write_tokens` stays the
  total** — token displays, the cache-hit ratio, and every non-Claude-Code
  connector are unaffected. Only the Claude Code projection fills it in; every
  other connector emits 0 (no other agent reports the split).
- **`cacheWrite1h` is optional, not required** — unlike the other four rate
  fields, an entry (model/family/default/provider) with no `cacheWrite1h` is
  still valid. The effective rate then falls back to 2x that SAME entry's
  `input`, matching Anthropic's actual pricing (the 1h multiplier is always 2x
  input), never a different layer's input.
- **Fallback computed per-layer, not by cascading to the next layer** — an
  exact-id model row with no `cacheWrite1h` uses 2x ITS OWN input, not the
  family's. This is why the exact-id join needs its own `input` column
  alongside the nullable `cache_write_1h`: `COALESCE(pr.cache_write_1h,
  pr.input * 2)` degrades to NULL (falling through to family/default) only
  when no exact-id row joined at all.
- **Clamp instead of validate** — the 1h portion is clamped to the total
  (`LEAST(cache_write_1h_tokens, cache_write_tokens)`) so a malformed or
  short split can't push the 5m portion negative, rather than rejecting the
  row.
- **Shipped `pricing.json` left unchanged** — its family cache-write rates
  already encode the 5m multiplier (1.25x input); the 1h rate is universally
  2x input on Anthropic's price list, which is exactly the fallback, so an
  explicit `cacheWrite1h` per family/model would be redundant.
- **Unusable `cacheWrite1h` is dropped, not fatal** — consistent with how
  `loadPricing` already treats a bad `contextWindow`: the rest of the entry
  survives, only the one field is silently dropped (rates are interpolated
  into SQL, so a bad value can't be allowed through as a literal).

## Approach

1. Add `cache_write_1h_tokens` to the canonical column contract
   (`connectors/canonical.ts`), the `events` schema (`db/schema.ts`, bumping
   `SCHEMA_VERSION`), and every connector's row construction (0 for all but
   Claude Code).
2. Claude Code's projection extracts the 1h portion from
   `usage.cache_creation.ephemeral_1h_input_tokens`.
3. Add the optional `cacheWrite1h` field to `ModelRates` (shared), validate it
   in `loadPricing` (drop if unusable, on models/families/providers/default),
   and map it from LiteLLM in `pricing-refresh.ts` (include it in change
   detection).
4. Add a nullable `cache_write_1h` column to the `pricing_rates` join table
   and a dedicated `cacheWrite1hRateExpr` alongside `buildCostExpr`'s existing
   per-field rate resolution, then split the cache-write cost term into a 5m
   portion (existing `cacheWrite` rate, remainder after clamping) and a 1h
   portion (the new rate).
5. Tests: a Claude Code fixture with an explicit `cacheWrite1h` rate prices
   both portions; a family with no `cacheWrite1h` falls back to 2x input; a
   legacy row with no `cache_creation` breakdown still prices flat; a LiteLLM
   fixture with/without `cache_creation_input_token_cost_above_1hr`.

## Files affected

- `packages/shared/src/pricing.ts` — optional `cacheWrite1h` on `ModelRates`.
- `packages/server/src/connectors/canonical.ts` — canonical column, row
  interface, `compactionRow` default.
- `packages/server/src/connectors/claude-code/claude-code.ts` — projects the
  1h portion from `usage.cache_creation.ephemeral_1h_input_tokens`.
- `packages/server/src/connectors/{antigravity,codex,copilot,grok,junie,opencode,pi}/normalize.ts`
  — emit `cache_write_1h_tokens: 0`.
- `packages/server/src/db/schema.ts` — `events.cache_write_1h_tokens` column,
  `SCHEMA_VERSION` bump (24).
- `packages/server/src/data/index.ts` — `pricing_rates.cache_write_1h` column,
  `cacheWrite1hRateExpr`, the split cost term in `buildCostExpr`, the extra
  column in `loadFile`'s staged projection.
- `packages/server/src/data/pricing.ts` — optional-field validation for
  `cacheWrite1h` (models/families/providers via `ratesOrNull`, `default`
  inline).
- `packages/server/src/data/pricing-refresh.ts` — maps
  `cache_creation_input_token_cost_above_1hr`, included in change detection.
- `packages/server/test/pricing.test.ts`,
  `packages/server/test/pricing-refresh.test.ts` — new coverage (see Testing).

## Testing

- `npm run typecheck` and `npm test` (Vitest) from the repo root.
- `packages/server/test/pricing.test.ts`: a Claude Code fixture row with an
  explicit 1h/5m split and a `cacheWrite1h` rate prices both portions; the
  same split with no `cacheWrite1h` configured falls back to 2x input (family
  rate); a row with no `cache_creation` breakdown at all still prices flat at
  `cacheWrite`, even when the resolved model DOES have a `cacheWrite1h` rate;
  `loadPricing` keeps a valid `cacheWrite1h` and drops an unusable one.
- `packages/server/test/pricing-refresh.test.ts`: `mapLiteLLM` carries
  `cache_creation_input_token_cost_above_1hr` through as `cacheWrite1h` when
  present and omits the key when absent; `refreshPricing`'s change-detection
  counts a change when only the 1h rate is added or removed.
- `packages/server/test/canonical-contract.test.ts` (existing fitness test)
  confirms Claude Code's hand-written projection still emits exactly the
  canonical column set.

## Risks / open questions

- A sibling branch (Codex guardian work) also adds a canonical column and
  bumps `SCHEMA_VERSION` around the same time — expected to land separately;
  no coordination needed beyond both triggering a reindex.
- The 2x-input-is-universal assumption for Anthropic's 1h cache-write rate is
  taken from the current published price list; if that ratio ever changes per
  model, the affected model/family would need an explicit `cacheWrite1h`
  entry in `pricing.json` (the mechanism already supports this — no code
  change needed, just data).
