/**
 * Request-parameter validation for values that end up inside SQL.
 *
 * Every query string in this app is interpolated into a statement (there are no
 * prepared statements — see `db/duckdb.ts`). `sqlString` makes that injection-safe,
 * but it does NOT make it *valid*: a date bound that DuckDB cannot cast aborts
 * the query, which surfaced as a 500 carrying the generated SQL. These helpers
 * reject such values at the boundary instead, and {@link BadRequestError} lets the
 * route layer map them to a 400 from one place (see `routes/index.ts`).
 *
 * Lives at the server root deliberately: both `data/` (analytics-scope) and
 * `routes/` consume it, so putting it in either would invert the layering.
 */

/**
 * A caller-supplied value was unusable. Mapped to `400` with `message` by the
 * error handler in `routes/index.ts`; anything else becomes a generic 500.
 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** `YYYY-MM-DD`, captured so calendar validity can be checked without coercion. */
const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True only for a real proleptic-Gregorian calendar day. */
function isCalendarDay(value: string): boolean {
  const match = ISO_DAY_RE.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;

  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

/**
 * Timestamp shapes accepted for a date bound. Covers exactly what the callers
 * send: `YYYY-MM-DD` (the MCP/CLI contract), and a full ISO timestamp with
 * optional seconds, fraction, and `Z`/±offset (what the web sends via
 * `toISOString()` and what the digest's default range builds). A space separator
 * is allowed because that is DuckDB's own canonical form.
 */
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * Validate an inclusive analytics date bound.
 *
 * Returns `undefined` for an absent/empty value (the bound is simply not
 * applied) and throws {@link BadRequestError} for anything unusable. The regex
 * checks shape, {@link isCalendarDay} checks the date without JavaScript's
 * overflow normalization, and `Date.parse` checks the remaining time/offset.
 *
 * The value is returned unchanged. The analytics scope layer decides whether
 * it is a calendar day/local wall time or an offset-bearing instant and emits
 * the corresponding DuckDB cast.
 */
export function timestampParam(raw: string | undefined, field: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '') return undefined;
  if (
    !TIMESTAMP_RE.test(value) ||
    !isCalendarDay(value.slice(0, 10)) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new BadRequestError(
      `${field} must be YYYY-MM-DD or an ISO timestamp (got '${value}')`,
    );
  }
  return value;
}

/**
 * Validate a calendar-day param. Unlike {@link timestampParam} an unusable value
 * is IGNORED rather than rejected: `today` only anchors the streak display, and
 * a bad clock on the client should not fail the whole analytics request.
 */
export function isoDayParam(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!isCalendarDay(value)) return undefined;
  return value;
}

/**
 * Validate a string-valued enum query param and apply its documented default.
 * TypeScript's unions disappear at runtime, so public routes must narrow the
 * arbitrary query string before treating it as one of those values.
 */
export function enumParam<const T extends string>(
  raw: string | undefined,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!allowed.some((candidate) => candidate === value)) {
    throw new BadRequestError(
      `${field} must be one of ${allowed.join(', ')} (got '${value}')`,
    );
  }
  return value as T;
}
