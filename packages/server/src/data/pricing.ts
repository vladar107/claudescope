/**
 * Pricing loader + cost computation.
 *
 * Placeholder: loads the user-editable {@link PRICING_PATH} JSON and computes
 * per-event USD cost from token usage. `<synthetic>` resolves to $0.
 */

import { readFileSync } from 'node:fs';
import type { PricingConfig } from '@claudescope/shared';
import { PRICING_PATH } from '../config.js';

let cached: PricingConfig | null = null;

/** Load (and cache) the pricing configuration from disk. */
export function loadPricing(): PricingConfig {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(PRICING_PATH, 'utf8')) as PricingConfig;
  return cached;
}
