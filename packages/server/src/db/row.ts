/**
 * Typed reader for DuckDB result rows.
 *
 * The route mappers translate snake_case columns into the camelCase shapes in
 * `@claudescope/shared`. That hop is hand-maintained and otherwise unchecked: if
 * a SELECT alias or schema column is renamed/dropped, `Number(r.col ?? 0)` would
 * silently yield a default (0 / '') and ship wrong data with no error. `readRow`
 * makes the contract loud — reading a column that isn't in the row throws, so
 * drift surfaces as a failure instead of a silent zero. A column that is present
 * but NULL still falls back to the supplied default (a legitimate value).
 */

export interface RowReader {
  /** Raw value after asserting the column is present (may be null). */
  req(col: string): unknown;
  /** Raw value if the column is present, else `undefined` (no drift check). */
  opt(col: string): unknown;
  /** String value; present-but-null → `fallback`. Throws if the column is absent. */
  str(col: string, fallback?: string): string;
  /** Finite number; present-but-null/NaN → `fallback`. Throws if the column is absent. */
  num(col: string, fallback?: number): number;
  /** Boolean value. Throws if the column is absent. */
  bool(col: string): boolean;
}

export function readRow(row: Record<string, unknown>, ctx: string): RowReader {
  const has = (col: string): boolean => Object.prototype.hasOwnProperty.call(row, col);
  const req = (col: string): unknown => {
    if (!has(col)) {
      throw new Error(`${ctx}: expected column '${col}' is missing from the row (SELECT alias drift?)`);
    }
    return row[col];
  };
  return {
    req,
    opt: (col) => (has(col) ? row[col] : undefined),
    str: (col, fallback = '') => {
      const v = req(col);
      return v != null ? String(v) : fallback;
    },
    num: (col, fallback = 0) => {
      const v = req(col);
      if (v == null) return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    },
    bool: (col) => Boolean(req(col)),
  };
}
