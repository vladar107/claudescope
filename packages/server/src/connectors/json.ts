/**
 * Defensive accessors for reading untrusted JSON in the connectors.
 *
 * Every normalizer walks `JSON.parse` output from a transcript it does not
 * control, so a missing or wrong-typed field must degrade rather than throw.
 * These three coercions were copy-pasted into all seven normalizers; `str` and
 * `num` were byte-identical, and `rec` had drifted into two variants (see below).
 */

/** A string, or `''` — never `undefined`, so callers can use it directly. */
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A finite number, or `0`. Rejects NaN/Infinity, which would poison sums. */
export const num = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/**
 * A plain object, or `{}` — so `rec(x).field` is always safe.
 *
 * Arrays are rejected. Two of the seven copies accepted them; unified on the
 * stricter form after confirming every call site only reads a property off the
 * result (never spreads or iterates it), which makes the two indistinguishable:
 * `[].field` and `{}.field` are both `undefined`.
 */
export const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
