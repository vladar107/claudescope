/**
 * Pricing loader + cost computation.
 *
 * Placeholder: loads the user-editable {@link PRICING_PATH} JSON and computes
 * per-event USD cost from token usage. `<synthetic>` resolves to $0.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { PricingConfig } from '@claudescope/shared';
import { DEFAULT_PRICING_PATH, PRICING_PATH } from '../config.js';

let cached: PricingConfig | null = null;

/**
 * Load (and cache) the pricing configuration from disk. Prefers the
 * user-editable copy in the state dir, falling back to the shipped default so a
 * fresh checkout (or a run before the state dir was seeded) still has rates.
 */
export function loadPricing(): PricingConfig {
  if (cached) return cached;
  const path = existsSync(PRICING_PATH) ? PRICING_PATH : DEFAULT_PRICING_PATH;
  cached = JSON.parse(readFileSync(path, 'utf8')) as PricingConfig;
  return cached;
}
