/**
 * Pricing loader.
 *
 * Loads a layered {@link PricingConfig}: a base layer (the user-editable
 * {@link PRICING_PATH}, falling back to the shipped {@link DEFAULT_PRICING_PATH})
 * with an optional overlay of runtime-fetched rates from
 * {@link FETCHED_PRICING_PATH}. Fetched rates win per exact model id; `families`
 * and `default` always come from the base layer (LiteLLM has no such concepts).
 *
 * The result is cached and keyed on the (mtime, existence) of both files, so an
 * edit to either — e.g. a `claudescope pricing update` rewriting the fetched
 * snapshot — is picked up on the next call (the reindex poll calls this every
 * ~15s) without restarting. A missing or corrupt fetched file is silently
 * ignored, leaving base-only behavior.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { FetchedPricing, PricingConfig } from '@claudescope/shared';
import { DEFAULT_PRICING_PATH, FETCHED_PRICING_PATH, PRICING_PATH } from '../config.js';

/** Sentinel mtime for a file that does not exist. */
const ABSENT = -1;

/** A cache key tracking the (existence, mtime) of both pricing layers. */
interface CacheKey {
  baseMtime: number;
  fetchedMtime: number;
}

let cached: { key: CacheKey; config: PricingConfig } | null = null;

/** stat a path for its mtime, returning {@link ABSENT} when it doesn't exist. */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return ABSENT;
  }
}

/** Read + parse the fetched snapshot, tolerating a missing or corrupt file. */
function readFetched(path: string): FetchedPricing | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FetchedPricing;
    if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Load (and cache) the layered pricing configuration from disk. Re-reads only
 * when either layer's file mtime or existence changed since the last call.
 */
export function loadPricing(): PricingConfig {
  const basePath = existsSync(PRICING_PATH) ? PRICING_PATH : DEFAULT_PRICING_PATH;
  const key: CacheKey = {
    baseMtime: mtimeOf(basePath),
    fetchedMtime: mtimeOf(FETCHED_PRICING_PATH),
  };

  if (cached && cached.key.baseMtime === key.baseMtime && cached.key.fetchedMtime === key.fetchedMtime) {
    return cached.config;
  }

  const base = JSON.parse(readFileSync(basePath, 'utf8')) as PricingConfig;

  // Overlay fetched rates per exact id; families/default stay from the base.
  let config = base;
  if (key.fetchedMtime !== ABSENT) {
    const fetched = readFetched(FETCHED_PRICING_PATH);
    if (fetched) {
      config = { ...base, models: { ...base.models, ...fetched.models } };
    }
  }

  cached = { key, config };
  return config;
}
