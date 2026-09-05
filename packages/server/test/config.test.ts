/**
 * Unit tests for resolveIntervalMs (config.ts): the shared validator behind
 * PRICING_REFRESH_INTERVAL_MS and SELF_RESTART_INTERVAL_MS. A typo used to
 * silently disable the feature (NaN) or, for a tiny value, fire the timer on
 * every millisecond — both fall back to the default with a warning instead.
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveIntervalMs } from '../src/config.js';

describe('resolveIntervalMs', () => {
  it('uses the default when the env var is unset', () => {
    expect(resolveIntervalMs('X_INTERVAL_MS', undefined, 5000)).toBe(5000);
  });

  it("treats '0' as an explicit disable, not an invalid value", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveIntervalMs('X_INTERVAL_MS', '0', 5000)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts an integer at or above the 1000ms floor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveIntervalMs('X_INTERVAL_MS', '1000', 5000)).toBe(1000);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['1', '-5', 'abc', '1.5', ''])(
    "falls back to the default and warns for '%s'",
    (raw) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(resolveIntervalMs('X_INTERVAL_MS', raw, 5000)).toBe(5000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('X_INTERVAL_MS');
      warn.mockRestore();
    },
  );
});
