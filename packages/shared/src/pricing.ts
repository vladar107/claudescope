/**
 * Pricing configuration types. The server loads a user-editable JSON file that
 * conforms to {@link PricingConfig}; rates are USD per million tokens.
 */

export interface ModelRates {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-write (cache-creation) tokens, 5-minute TTL. */
  cacheWrite: number;
  /**
   * USD per 1M cache-write tokens billed at the 1-hour TTL rate. Optional: when
   * a resolved entry (model/family/default/provider) has no explicit value, the
   * effective rate is 2× that same entry's `input` — Anthropic's 1h cache-write
   * multiplier — computed at cost time (`data/index.ts:buildCostExpr`).
   */
  cacheWrite1h?: number;
  /** USD per 1M cache-read tokens. */
  cacheRead: number;
  /**
   * Model context window in tokens (LiteLLM `max_input_tokens`), when known.
   * Not a rate: it only feeds the "context used" percentage in the UI.
   */
  contextWindow?: number;
  /**
   * Premium "fast mode" rates (Claude Code `usage.speed: "fast"`, Codex's
   * `priority` service tier). Optional and model-specific by design — Anthropic
   * only prices fast mode for a handful of Opus models, and a model that merely
   * accepts the fast/priority flag without billing it differently must not get
   * one. Only ever read from an EXACT-id `models` entry at cost time
   * (`data/index.ts:buildCostExpr`); a family/provider/default `fast` block, if
   * set, is validated but never consulted for pricing.
   */
  fast?: FastRates;
}

/** Rates for fast-mode usage — same shape as the base rates minus the window. */
export interface FastRates {
  /** USD per 1M input tokens at fast-mode speed. */
  input: number;
  /** USD per 1M output tokens at fast-mode speed. */
  output: number;
  /** USD per 1M cache-write tokens at fast-mode speed, 5-minute TTL. */
  cacheWrite: number;
  /** USD per 1M cache-read tokens at fast-mode speed. */
  cacheRead: number;
  /**
   * USD per 1M cache-write tokens at fast-mode speed, 1-hour TTL. Optional: when
   * unset, the effective rate is 2× this same block's `input` — the same
   * fallback rule as the base `cacheWrite1h`.
   */
  cacheWrite1h?: number;
}

/** Snapshot of rates fetched at runtime (e.g. from LiteLLM). */
export interface FetchedPricing {
  /** ISO timestamp of the successful fetch. */
  fetchedAt: string;
  /** Per-model rate table, keyed by exact model id. */
  models: Record<string, ModelRates>;
}

export interface PricingConfig {
  /**
   * Schema version of the shipped default. Present in the shipped `pricing.json`
   * and stamped into the seeded/migrated user copy; absent means a legacy (v0)
   * copy. Used to reconcile an out-of-date user copy with a newer default on
   * startup. Bumped when the shipped families/default/shape change.
   */
  schemaVersion?: number;
  /** Per-model rate table, keyed by exact model id (highest precedence). */
  models: Record<string, ModelRates>;
  /**
   * Family rates, keyed by a lowercase substring matched against the model id
   * (e.g. "opus", "sonnet", "haiku"). Used when no exact `models` entry matches,
   * so any version/date-suffixed id (e.g. `claude-haiku-4-5-20251001`) still
   * resolves. Checked after `models`, before `default`.
   */
  families?: Record<string, ModelRates>;
  /**
   * Per-provider rate table, keyed by lowercase provider id, matched
   * case-insensitively against the provider recorded on an assistant event (pi
   * `message.provider`, Codex `session_meta.model_provider`, opencode
   * `providerID`). A match OVERRIDES the models/families/default chain entirely —
   * this is how local runtimes (`ollama`, `lmstudio`, …) are zero-rated
   * regardless of model id. Events with no recorded provider, or an unlisted
   * provider, price by model as before.
   */
  providers?: Record<string, ModelRates>;
  /** Fallback rates used when neither an exact id nor a family matches. */
  default: ModelRates;
}

/** True when every rate is 0 — the marker for a "local" (free) provider. */
export function isZeroRated(r: ModelRates): boolean {
  return r.input === 0 && r.output === 0 && r.cacheWrite === 0 && r.cacheRead === 0;
}
