/**
 * Pricing configuration types. The server loads a user-editable JSON file that
 * conforms to {@link PricingConfig}; rates are USD per million tokens.
 */

export interface ModelRates {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-write (cache-creation) tokens. */
  cacheWrite: number;
  /** USD per 1M cache-read tokens. */
  cacheRead: number;
}

export interface PricingConfig {
  /** Per-model rate table, keyed by model id. */
  models: Record<string, ModelRates>;
  /** Fallback rates used when a model id is not present in `models`. */
  default: ModelRates;
}
