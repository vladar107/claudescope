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
  /** Per-model rate table, keyed by exact model id (highest precedence). */
  models: Record<string, ModelRates>;
  /**
   * Family rates, keyed by a lowercase substring matched against the model id
   * (e.g. "opus", "sonnet", "haiku"). Used when no exact `models` entry matches,
   * so any version/date-suffixed id (e.g. `claude-haiku-4-5-20251001`) still
   * resolves. Checked after `models`, before `default`.
   */
  families?: Record<string, ModelRates>;
  /** Fallback rates used when neither an exact id nor a family matches. */
  default: ModelRates;
}
