/**
 * Pricing loader.
 *
 * Loads a layered {@link PricingConfig}: a base layer (the user-editable
 * {@link PRICING_PATH}, falling back to the shipped {@link DEFAULT_PRICING_PATH})
 * with an optional overlay of runtime-fetched rates from
 * {@link FETCHED_PRICING_PATH}. Fetched rates win per exact model id (a
 * user-set `contextWindow` on that id survives); `families` and `default`
 * always come from the base layer (LiteLLM has no such concepts).
 *
 * The result is cached and keyed on the (mtime, existence) of both files, so an
 * edit to either — e.g. a `claudescope pricing update` rewriting the fetched
 * snapshot — is picked up on the next call (the reindex poll calls this every
 * ~15s) without restarting. A missing or corrupt fetched file is silently
 * ignored, leaving base-only behavior.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { FetchedPricing, ModelRates, PricingConfig } from '@claudescope/shared';
import { DEFAULT_PRICING_PATH, FETCHED_PRICING_PATH, PRICING_PATH } from '../config.js';

/** The four rate fields every {@link ModelRates} must carry. */
const RATE_FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'] as const;

/**
 * A finite, non-negative number, else `null`. Rates are interpolated straight
 * into the SQL cost expression (see `data/index.ts:buildCostExpr`), so a value
 * that isn't a real number is not merely wrong — it produces invalid SQL that
 * fails the whole load. `pricing.json` is user-editable by design, so a typo
 * like `"3.00 USD"` has to be survivable.
 */
function rateOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * A fully-valid {@link ModelRates}, or `null` if any rate is unusable. The
 * optional `contextWindow` is not a rate (it never reaches SQL): it is kept
 * when a positive integer and silently left out otherwise.
 */
function ratesOrNull(value: unknown): ModelRates | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const out = {} as ModelRates;
  for (const field of RATE_FIELDS) {
    const n = rateOrNull(raw[field]);
    if (n === null) return null;
    out[field] = n;
  }
  const window = raw.contextWindow;
  if (typeof window === 'number' && Number.isInteger(window) && window > 0) out.contextWindow = window;
  return out;
}

/**
 * The context window (tokens) pricing knows for a model id: the exact-id entry
 * first, then the first substring family that defines one — the same
 * `models` → `families` chain the cost expression uses (`data/index.ts:
 * buildCostExpr`), minus the default, which has no window. `undefined` when
 * unknown; the UI then shows the absolute context size without a percentage.
 */
export function contextWindowFor(model: string | null | undefined, pricing: PricingConfig): number | undefined {
  if (!model) return undefined;
  const exact = pricing.models[model]?.contextWindow;
  if (exact !== undefined) return exact;
  const id = model.toLowerCase();
  for (const [family, rates] of Object.entries(pricing.families ?? {})) {
    if (rates.contextWindow !== undefined && id.includes(family.toLowerCase())) return rates.contextWindow;
  }
  return undefined;
}

/**
 * Drop every entry with an unusable rate from a keyed rate table. Dropping (not
 * repairing) is deliberate: the cost chain is `models` → `families` → `default`,
 * so a dropped entry falls through to the next layer — the same choice
 * `pricing-refresh.ts:mapLiteLLM` makes for fetched rates.
 */
function sanitizeTable(
  table: Record<string, unknown> | undefined,
  label: string,
  dropped: string[],
): Record<string, ModelRates> {
  const out: Record<string, ModelRates> = {};
  for (const [key, value] of Object.entries(table ?? {})) {
    const rates = ratesOrNull(value);
    if (rates) out[key] = rates;
    else dropped.push(`${label}.${key}`);
  }
  return out;
}

/**
 * Validate a parsed config so no unusable rate can reach the SQL builder.
 *
 * `default` is the terminal fallback and cannot be dropped, so an unusable field
 * there is zeroed — a visibly wrong 0 beats an invisible indexer failure. Every
 * rejection is named in the warning, which fires only on a cache miss (i.e. once
 * per edit, not once per reindex poll).
 */
function sanitizeConfig(raw: PricingConfig, sourcePath: string): PricingConfig {
  const dropped: string[] = [];
  const models = sanitizeTable(raw.models as unknown as Record<string, unknown>, 'models', dropped);
  const families = sanitizeTable(raw.families as unknown as Record<string, unknown>, 'families', dropped);
  const providers = sanitizeTable(raw.providers as unknown as Record<string, unknown>, 'providers', dropped);

  const fallback = {} as ModelRates;
  for (const field of RATE_FIELDS) {
    const n = rateOrNull((raw.default as unknown as Record<string, unknown> | undefined)?.[field]);
    if (n === null) dropped.push(`default.${field} (treated as 0)`);
    fallback[field] = n ?? 0;
  }

  if (dropped.length > 0) {
    console.warn(
      `[pricing] ignoring unusable rate(s) in ${sourcePath}: ${dropped.join(', ')} — ` +
        'rates must be finite non-negative numbers (USD per 1M tokens)',
    );
  }

  return {
    ...(raw.schemaVersion !== undefined ? { schemaVersion: raw.schemaVersion } : {}),
    models,
    families,
    providers,
    default: fallback,
  };
}

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

  // Validate on the way in: rates are interpolated into SQL, so an unusable
  // value would fail the load (and, pre-transaction, could destroy indexed rows).
  const base = sanitizeConfig(
    JSON.parse(readFileSync(basePath, 'utf8')) as PricingConfig,
    basePath,
  );

  // Overlay fetched rates per exact id; families/default stay from the base.
  let config = base;
  if (key.fetchedMtime !== ABSENT) {
    const fetched = readFetched(FETCHED_PRICING_PATH);
    if (fetched) {
      // The snapshot is written by refreshPricing (already validated), but it's
      // a plain file on disk and may have been hand-edited — validate it too.
      const overlay = sanitizeTable(
        fetched.models as unknown as Record<string, unknown>,
        'fetched.models',
        [],
      );
      const models = { ...base.models, ...overlay };
      // Rates come from the feed, but a window the user wrote on an exact id in
      // pricing.json is a deliberate override (e.g. a 1M-context variant LiteLLM
      // lists under another id): keep it on top of the fetched entry.
      for (const [id, rates] of Object.entries(base.models)) {
        if (rates.contextWindow !== undefined && id in overlay) {
          models[id] = { ...models[id]!, contextWindow: rates.contextWindow };
        }
      }
      config = { ...base, models };
    }
  }

  cached = { key, config };
  return config;
}
