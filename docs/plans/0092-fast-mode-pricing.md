# 0092 — Fast-mode pricing

- **Status:** done
- **Date:** 2026-09-23
- **PR:** https://github.com/vladar107/claudescope/pull/121

## Context

Stacks on [0090 (1-hour cache-write pricing, #119)](./0090-cache-write-1h-pricing.md).

Both agents' "fast mode" usage is currently priced at standard rates. Claude
Code records `message.usage.speed: "standard" | "fast"`; per Anthropic's price
list, fast mode only bills differently for Claude Opus 5.5 ($8 input / $40
output per MTok) and Claude Opus 5 / 4.8 ($10 / $50) — Opus 4.6 accepts the
`speed=fast` flag but bills standard, so fast rates must be model-specific,
never a whole `opus` family. Prompt-caching multipliers apply on top of fast
pricing (5m cache write = 1.25× fast input, 1h = 2× fast input, cache read =
the model's normal read multiplier × fast input). Codex's fast mode is
OpenAI's `priority` service tier, set by `thread_settings_applied` events and
applied to subsequent `token_count` usage until changed; LiteLLM publishes
exact `*_priority` rate fields for it.

## Goal

Price fast-mode / priority-tier usage at its real premium rates, exact-id
only, falling back to standard pricing whenever a model has no fast rate
configured — never fabricating a multiplier.

## Decisions

- **New canonical nullable column `speed`** (`'fast'` | NULL), sitting next to
  `service_tier`. Claude Code's projection normalizes any value other than the
  literal `'fast'` (including `'standard'`) to NULL. Every connector but Claude
  Code and Codex emits NULL unconditionally — the mechanism is opt-in per
  connector, same as `cache_write_1h_tokens` in 0090.
- **Codex tracks the service tier as parser state**, seeded from
  `turn_context.payload.service_tier` and updated by `event_msg` records with
  `payload.type === "thread_settings_applied"` (`payload.thread_settings.
  service_tier`). Applied to the currently-open assistant turn's accumulated
  usage at each `token_count` delta — last tier at token_count time wins for
  that turn, since a turn typically doesn't straddle a tier change.
- **`fast` is a new optional nested rate block on `ModelRates`** (shared
  `FastRates`: input/output/cacheWrite/cacheRead required, `cacheWrite1h`
  optional, same fallback rule as the base rate — 2× the block's own `input`).
  Validated by `loadPricing` with the same all-or-nothing rule as the base
  rates: any unusable required field drops the whole `fast` block, never the
  entry it lives on.
- **Fast mode is EXACT-ID ONLY in the cost expression** — never family,
  default, or provider (beyond the provider override itself, which still wins
  over everything). `pricing_rates` gets nullable `fast_input`/`fast_output`/
  `fast_cache_write`/`fast_cache_read`/`fast_cache_write_1h` columns, populated
  only from `pricing.models` (exact ids); a family/default/provider `fast`
  block, if a user sets one, is validated but never synced or read. This is
  the direct encoding of "Opus 4.6 accepts speed=fast but bills standard" —
  fast pricing has to be an explicit, per-model opt-in.
- **SQL shape**: `buildCostExpr`'s `rateExpr` helper (input/output/cacheRead,
  plus the cacheWrite 5m term) and `cacheWrite1hRateExpr` both grow one
  speed-aware layer inserted between the exact-id join and the provider
  override: `CASE WHEN ev.speed = 'fast' THEN COALESCE(pr.fast_<col>,
  <standard chain>) ELSE <standard chain> END`. Reusing `<standard chain>`
  verbatim in the fast branch's fallback is what makes "fast usage on a model
  without a fast rate prices standard" fall out for free, instead of a second
  hand-written CASE tree. Provider override stays outermost, so it wins over
  fast exactly like it wins over everything else.
- **Fetched-overlay merge preserves a shipped/user `fast` block** the same way
  it already preserves a user-set `contextWindow`: after the exact-id overlay
  replaces `base.models[id]` wholesale, a second pass patches `fast` back from
  `base` onto any id also present in the overlay. LiteLLM has no Claude fast
  rates at all, so without this a routine pricing refresh would silently wipe
  the Opus 5.5/5/4.8 fast blocks.
- **LiteLLM mapping**: `input_cost_per_token_priority` /
  `output_cost_per_token_priority` must both be present and usable, or no
  `fast` block is emitted. A missing (not merely zero) priority cache rate
  falls back to the base cache rate scaled by the priority/base input ratio,
  rather than defaulting to 0 like the ordinary cache-rate mapping — kept
  simple on purpose (LiteLLM doesn't always publish a separate priority cache
  rate, but the input/output multiplier is assumed to carry over). Included in
  `refreshPricing`'s change-detection count.
- **Shipped `pricing.json`** gains exact-id entries for `claude-opus-5-5`,
  `claude-opus-5`, `claude-opus-4-8` with a `fast` block (numbers above,
  `cacheWrite1h`: 16 / 20 / 20). Their STANDARD rates mirror the existing
  `opus` family literally (5/25/6.25/0.5) — no standard-rate change was
  specified, so adding the exact id must not silently change non-fast pricing
  for these models versus falling through to the family today. Shipped
  `pricing.json`'s `schemaVersion` bumps 4 → 5 (and `PRICING_SCHEMA_VERSION` in
  `config.ts`) so an existing user copy reconciles in the new models.
- **`SCHEMA_VERSION` bumps** 25 → 26 so already-indexed history is re-priced
  with the new column and cost logic.

## Approach

1. `connectors/canonical.ts`: `speed` canonical column, `CanonicalRow` field,
   `compactionRow` default.
2. Claude Code (`claude-code.ts`): `speed` from `usage.speed` via a `CASE`
   (no inline `--` SQL comment inside the SELECT list, per
   `canonical-contract.test.ts`).
3. Codex (`codex/normalize.ts`): track `serviceTier` parser state from
   `turn_context`/`thread_settings_applied`, stamp it onto each `token_count`
   usage delta as `speed`, surface it in `toCanonicalRows`.
4. Every other connector: `speed: null`.
5. `db/schema.ts`: `events.speed VARCHAR`, `SCHEMA_VERSION` 26.
6. `shared/pricing.ts`: `FastRates`, optional `fast?: FastRates` on
   `ModelRates`.
7. `data/pricing.ts`: `fastRatesOrNull` (mirrors `ratesOrNull`'s all-or-nothing
   rule), wired into `ratesOrNull` and the `default` branch of
   `sanitizeConfig`; `loadPricing`'s fetched-overlay merge preserves a base
   `fast` block per exact id, same idiom as `contextWindow`.
8. `data/pricing-refresh.ts`: `LiteLLMEntry` priority fields, `mapPriorityRates`
   (ratio-fallback cache rates), wired into `mapLiteLLM`; `countChanged`
   compares `fast` blocks too.
9. `data/index.ts`: `pricing_rates` gains the five `fast_*` columns
   (`syncPricingTable`); `buildCostExpr`'s `rateExpr` and
   `cacheWrite1hRateExpr` both grow the speed-aware CASE layer; `loadFile`'s
   staged SELECT adds `ev.speed`.
10. `packages/server/pricing.json`: the three exact-id fast entries,
    `schemaVersion` 5; `config.ts`: `PRICING_SCHEMA_VERSION` 5.
11. Tests (see below).

## Files affected

- `packages/shared/src/pricing.ts` — `FastRates`, `ModelRates.fast`.
- `packages/server/src/connectors/canonical.ts` — `speed` canonical column.
- `packages/server/src/connectors/claude-code/claude-code.ts` — projects
  `speed` from `usage.speed`.
- `packages/server/src/connectors/codex/normalize.ts` — tracks the service
  tier and stamps `speed` on usage.
- `packages/server/src/connectors/{antigravity,copilot,grok,junie,opencode,pi}/normalize.ts`
  — emit `speed: null`.
- `packages/server/src/db/schema.ts` — `events.speed`, `SCHEMA_VERSION` 26.
- `packages/server/src/data/index.ts` — `pricing_rates.fast_*`, speed-aware
  `rateExpr` / `cacheWrite1hRateExpr`, `loadFile`'s staged SELECT.
- `packages/server/src/data/pricing.ts` — `fastRatesOrNull`, fetched-overlay
  `fast` preservation.
- `packages/server/src/data/pricing-refresh.ts` — `mapPriorityRates`,
  change-detection.
- `packages/server/pricing.json`, `packages/server/src/config.ts` — shipped
  fast entries, schema version bump.
- `packages/server/test/pricing.test.ts`,
  `packages/server/test/pricing-refresh.test.ts` — new coverage (see Testing).

## Testing

- `npm run typecheck` and `npm test` (Vitest) from the repo root.
- `packages/server/test/pricing.test.ts`: a Claude fast row on
  `claude-opus-5-5` prices at fast rates including the 1h/5m cache-write
  split; a fast row on a model with no `fast` block prices exactly like the
  same row without `speed` at all; a fast row with a `fast` block but no
  configured `fast.cacheWrite1h` falls back to 2× FAST input, not 2× standard
  input; a Codex rollout toggling `default → priority → default` prices only
  the priority-period usage at the fast rate; `loadPricing` keeps a valid
  `fast` block and drops an unusable one silently; a fetched exact-id entry
  does not drop a shipped/user `fast` block for the same id.
- `packages/server/test/pricing-refresh.test.ts`: `mapLiteLLM` maps
  `*_priority` fields into `fast`, including the base-rate-ratio fallback for
  an unpublished priority cache rate, and omits `fast` entirely when the
  source has none; `refreshPricing`'s change-detection counts a change when
  only the fast rates are added or removed.
- `packages/server/test/canonical-contract.test.ts` (existing fitness test)
  confirms Claude Code's hand-written projection still emits exactly the
  canonical column set.

## Risks / open questions

- The exact-id `fast` block only ever prices from `pricing.models`; a
  family/provider/default `fast` a user might set is validated but silently
  inert. This is intentional (fast pricing must be model-specific) but is
  worth a one-line callout if support tickets ask why a family-level `fast`
  "doesn't work."
- Codex's tier tracking assumes a turn doesn't straddle a
  `thread_settings_applied` change — the last tier seen before a `token_count`
  event wins for that whole accumulated turn. Not expected in practice (tier
  changes are user-initiated, between turns), but not enforced either.
- The standard (non-fast) rates for the three new shipped Opus exact ids are
  inferred to equal the existing `opus` family rate (no override was
  specified) — if Anthropic's actual non-fast pricing for these models ever
  diverges from the family rate, `pricing.json` needs a data-only update, no
  code change.
