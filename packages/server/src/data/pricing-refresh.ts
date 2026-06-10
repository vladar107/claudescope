/**
 * Runtime pricing refresh from LiteLLM.
 *
 * Fetches LiteLLM's community-maintained price table, maps the allowlisted
 * chat/responses models to our per-MTok {@link ModelRates} shape, validates the
 * result, and atomically writes a {@link FetchedPricing} snapshot to
 * {@link FETCHED_PRICING_PATH}. The snapshot survives index rebuilds and is
 * layered over the local `pricing.json` by the loader (wired in a later wave).
 *
 * Pure mappers/validators are exported for unit testing. This module has no
 * import-time side effects and never touches DuckDB.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FetchedPricing, ModelRates } from '@claudescope/shared';
import { FETCHED_PRICING_PATH, LITELLM_PRICING_URL } from '../config.js';

/**
 * Providers whose models we keep. Bare transcript model ids only ever match
 * these "first-party" providers; Bedrock/Azure/Vertex/router duplicates use
 * provider-prefixed ids that would never match and are dropped.
 */
const ALLOWED_PROVIDERS = new Set([
  'anthropic',
  'openai',
  'gemini',
  'xai',
  'mistral',
  'deepseek',
]);

/**
 * LiteLLM `mode` values we treat as chat-style. `responses` covers OpenAI's
 * Responses-API models (e.g. `gpt-5-codex`, `o3-pro`) that transcripts do use.
 */
const CHAT_MODES = new Set(['chat', 'responses']);

/** Convert per-token USD to per-MTok USD. */
const PER_MTOK = 1_000_000;

/** Reject any rate above this (USD per MTok) as a parse error / bad data. */
const SANITY_CAP = 10_000;

/** Network timeout for the fetch; the file is a few MB. */
const FETCH_TIMEOUT_MS = 30_000;

/** Shape of a single LiteLLM entry we read (other fields ignored). */
interface LiteLLMEntry {
  litellm_provider?: unknown;
  mode?: unknown;
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_creation_input_token_cost?: unknown;
  cache_read_input_token_cost?: unknown;
}

/** A finite, non-negative number within the sanity cap, else `null`. */
function toRate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const rate = value * PER_MTOK;
  return rate <= SANITY_CAP ? rate : null;
}

/** An optional cache rate: missing/undefined → 0; invalid/out-of-range → null. */
function toCacheRate(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  return toRate(value);
}

/**
 * Map a parsed LiteLLM JSON object to our per-MTok rate table. Pure; exported
 * for tests.
 *
 * Keeps entries whose `litellm_provider` is allowlisted and whose `mode` is
 * chat-style. Provider-prefixed keys (e.g. `gemini/gemini-2.5-pro`) are skipped
 * — transcripts store bare model ids, and the bare id is present for these
 * providers. Individual entries with missing/invalid input or output cost (or
 * any rate over the sanity cap) are skipped, not fatal. Missing cache fields
 * default to 0.
 */
export function mapLiteLLM(json: unknown): Record<string, ModelRates> {
  const out: Record<string, ModelRates> = {};
  if (typeof json !== 'object' || json === null) return out;

  for (const [id, raw] of Object.entries(json as Record<string, unknown>)) {
    if (id === 'sample_spec') continue;
    if (id.includes('/')) continue; // skip provider-prefixed duplicates
    if (typeof raw !== 'object' || raw === null) continue;

    const entry = raw as LiteLLMEntry;
    if (typeof entry.litellm_provider !== 'string' || !ALLOWED_PROVIDERS.has(entry.litellm_provider)) {
      continue;
    }
    if (typeof entry.mode !== 'string' || !CHAT_MODES.has(entry.mode)) continue;

    const input = toRate(entry.input_cost_per_token);
    const output = toRate(entry.output_cost_per_token);
    const cacheWrite = toCacheRate(entry.cache_creation_input_token_cost);
    const cacheRead = toCacheRate(entry.cache_read_input_token_cost);
    // Skip entries that fail any rate check rather than failing the whole map.
    if (input === null || output === null || cacheWrite === null || cacheRead === null) {
      continue;
    }

    out[id] = { input, output, cacheWrite, cacheRead };
  }

  return out;
}

/**
 * Throw unless the mapped table looks usable: at least one anthropic and one
 * openai model survived. We track this by id pattern so other providers
 * disappearing upstream never aborts the refresh. Exported for tests.
 */
export function validateFetched(models: Record<string, ModelRates>): void {
  const ids = Object.keys(models);
  const hasAnthropic = ids.some((id) => id.startsWith('claude'));
  const hasOpenai = ids.some((id) => /^(gpt|o\d|chatgpt|codex)/.test(id));
  if (!hasAnthropic || !hasOpenai) {
    const missing = [!hasAnthropic && 'anthropic', !hasOpenai && 'openai'].filter(Boolean).join(', ');
    throw new Error(
      `Fetched pricing failed validation: no ${missing} model survived mapping ` +
        `(${ids.length} model(s) total). LiteLLM schema may have drifted.`,
    );
  }
}

/** Read the previous snapshot, tolerating a missing or corrupt file. */
function readPreviousModels(path: string): Record<string, ModelRates> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FetchedPricing;
    return parsed?.models ?? {};
  } catch {
    return {};
  }
}

/** Count model ids whose rates differ from (or are absent in) the previous set. */
function countChanged(
  next: Record<string, ModelRates>,
  prev: Record<string, ModelRates>,
): number {
  let changed = 0;
  for (const [id, rates] of Object.entries(next)) {
    const before = prev[id];
    if (
      !before ||
      before.input !== rates.input ||
      before.output !== rates.output ||
      before.cacheWrite !== rates.cacheWrite ||
      before.cacheRead !== rates.cacheRead
    ) {
      changed += 1;
    }
  }
  return changed;
}

/**
 * Fetch LiteLLM pricing, map + validate it, and atomically write the snapshot.
 *
 * On any failure (network, non-OK response, parse error, validation) this
 * throws and the existing snapshot file is left untouched, so callers fall back
 * to last-known rates. Returns a summary of the write.
 */
export async function refreshPricing(): Promise<{
  fetchedAt: string;
  modelCount: number;
  changed: number;
  path: string;
}> {
  const res = await fetch(LITELLM_PRICING_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Pricing fetch failed: ${res.status} ${res.statusText}`);
  }

  const json: unknown = await res.json();
  const models = mapLiteLLM(json);
  validateFetched(models);

  const prev = readPreviousModels(FETCHED_PRICING_PATH);
  const changed = countChanged(models, prev);

  const fetchedAt = new Date().toISOString();
  const snapshot: FetchedPricing = { fetchedAt, models };

  // Atomic write: stage to a temp file in the same dir, then rename over target.
  mkdirSync(dirname(FETCHED_PRICING_PATH), { recursive: true });
  const tmp = join(dirname(FETCHED_PRICING_PATH), `.pricing.fetched.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(tmp, FETCHED_PRICING_PATH);

  return { fetchedAt, modelCount: Object.keys(models).length, changed, path: FETCHED_PRICING_PATH };
}
