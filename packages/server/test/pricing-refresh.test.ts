/**
 * Unit tests for the runtime pricing refresh. Fixture-based; no network.
 *
 * The fixture mirrors the real LiteLLM `model_prices_and_context_window.json`
 * shape (per-token USD costs, `litellm_provider`, `mode`, a `sample_spec` key)
 * and exercises mapping, validation, and the end-to-end `refreshPricing` write
 * with `fetch` stubbed and FETCHED_PRICING_PATH pointed at a temp dir. The env
 * override is set before importing the module, since config.ts reads env at
 * import time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- temp snapshot location (decided before the module under test imports) ---
const work = mkdtempSync(join(tmpdir(), 'claudescope-pricing-'));
const fetchedPath = join(work, 'pricing.fetched.json');
process.env.FETCHED_PRICING_PATH = fetchedPath;

const { mapLiteLLM, validateFetched, refreshPricing } = await import('../src/data/pricing-refresh.js');

/** A LiteLLM-shaped fixture covering every mapping branch. */
const LITELLM = {
  sample_spec: {
    input_cost_per_token: 0.0,
    output_cost_per_token: 0.0,
    litellm_provider: 'one of https://docs.litellm.ai/docs/providers',
    mode: 'chat',
  },
  // anthropic chat model with all four rates present.
  'claude-sonnet-4-5': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_creation_input_token_cost: 3.75e-6,
    cache_read_input_token_cost: 0.3e-6,
  },
  // openai chat model missing cache fields (one null, one absent) → 0.
  'gpt-5': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 10e-6,
    cache_read_input_token_cost: 0.125e-6,
    cache_creation_input_token_cost: null,
  },
  // openai responses-mode model (e.g. Codex) — must be kept.
  'gpt-5-codex': {
    litellm_provider: 'openai',
    mode: 'responses',
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 10e-6,
  },
  // provider-prefixed duplicate — must be skipped (bare id stored in transcripts).
  'gemini/gemini-2.5-pro': {
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 10e-6,
  },
  // non-allowlisted provider — skipped.
  'bedrock-claude': {
    litellm_provider: 'bedrock',
    mode: 'chat',
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
  },
  // non-chat mode — skipped.
  'text-embedding-3-small': {
    litellm_provider: 'openai',
    mode: 'embedding',
    input_cost_per_token: 0.02e-6,
    output_cost_per_token: 0,
  },
  // malformed: missing output cost — skipped without throwing.
  'mistral-broken': {
    litellm_provider: 'mistral',
    mode: 'chat',
    input_cost_per_token: 2e-6,
  },
  // sanity-cap violation ($10,001 per MTok input) — skipped.
  'xai-absurd': {
    litellm_provider: 'xai',
    mode: 'chat',
    input_cost_per_token: 0.010001,
    output_cost_per_token: 1e-6,
  },
};

describe('mapLiteLLM', () => {
  const rates = mapLiteLLM(LITELLM);

  it('maps per-token to per-MTok and keeps all four rates', () => {
    expect(rates['claude-sonnet-4-5']).toEqual({
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    });
  });

  it('defaults missing/null cache fields to 0', () => {
    expect(rates['gpt-5']).toEqual({ input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 });
  });

  it('keeps responses-mode models (e.g. Codex)', () => {
    expect(rates['gpt-5-codex']).toEqual({ input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0 });
  });

  it('skips provider-prefixed duplicate keys', () => {
    expect(rates['gemini/gemini-2.5-pro']).toBeUndefined();
  });

  it('skips non-allowlisted providers', () => {
    expect(rates['bedrock-claude']).toBeUndefined();
  });

  it('skips non-chat modes', () => {
    expect(rates['text-embedding-3-small']).toBeUndefined();
  });

  it('skips malformed entries (missing output cost) without throwing', () => {
    expect(rates['mistral-broken']).toBeUndefined();
  });

  it('skips sanity-cap violations', () => {
    expect(rates['xai-absurd']).toBeUndefined();
  });

  it('ignores the sample_spec key', () => {
    expect(rates.sample_spec).toBeUndefined();
  });
});

describe('validateFetched', () => {
  it('passes when both anthropic and openai survive', () => {
    expect(() => validateFetched(mapLiteLLM(LITELLM))).not.toThrow();
  });

  it('throws when no anthropic model survives', () => {
    expect(() => validateFetched({ 'gpt-5': { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 } })).toThrow(
      /anthropic/,
    );
  });

  it('throws when no openai model survives', () => {
    expect(() =>
      validateFetched({ 'claude-sonnet-4-5': { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 } }),
    ).toThrow(/openai/);
  });
});

describe('refreshPricing', () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

  beforeEach(() => {
    if (existsSync(fetchedPath)) rmSync(fetchedPath);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes a FetchedPricing snapshot with fetchedAt + models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(LITELLM)));

    const result = await refreshPricing();
    expect(result.path).toBe(fetchedPath);
    expect(result.modelCount).toBe(3); // claude-sonnet-4-5, gpt-5, gpt-5-codex
    expect(result.changed).toBe(3); // no previous snapshot → all changed

    const snapshot = JSON.parse(readFileSync(fetchedPath, 'utf8'));
    expect(typeof snapshot.fetchedAt).toBe('string');
    expect(snapshot.fetchedAt).toBe(result.fetchedAt);
    expect(snapshot.models['claude-sonnet-4-5']).toEqual({
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    });
  });

  it('counts only changed rates on a second run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(LITELLM)));
    await refreshPricing();

    // Alter exactly one model's rate; the others are identical.
    const altered = {
      ...LITELLM,
      'gpt-5': { ...LITELLM['gpt-5'], output_cost_per_token: 20e-6 },
    };
    vi.stubGlobal('fetch', vi.fn(async () => ok(altered)));

    const result = await refreshPricing();
    expect(result.changed).toBe(1);
    expect(result.modelCount).toBe(3);
  });

  it('leaves an existing snapshot untouched when the fetch is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(LITELLM)));
    await refreshPricing();
    const before = readFileSync(fetchedPath, 'utf8');

    // A valid HTTP response whose body fails validation (no anthropic/openai).
    vi.stubGlobal('fetch', vi.fn(async () => ok({ sample_spec: {} })));
    await expect(refreshPricing()).rejects.toThrow();

    expect(readFileSync(fetchedPath, 'utf8')).toBe(before);
  });

  it('throws and writes nothing on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }) as Response),
    );
    await expect(refreshPricing()).rejects.toThrow(/503/);
    expect(existsSync(fetchedPath)).toBe(false);
  });
});

// Best-effort cleanup of the temp dir after the suite.
process.on('exit', () => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
