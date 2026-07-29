/**
 * The cache-hit ratio has to exist twice — as TypeScript for the routes that
 * compute it per row, and as SQL because `/api/analytics/sessions` makes
 * `cache_hit_ratio` a sortable column and feeds it to `quantile_cont`. Neither
 * can replace the other, so this asserts they agree.
 *
 * It also pins the new generated SQL against the hand-written expression it
 * replaced, so the consolidation provably didn't change any number. Before this,
 * there were three implementations (two identical TS functions plus the SQL) and
 * `analytics.ts`'s own header documented a *different* formula from the one its
 * code computed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { cacheHitRatio, cacheHitRatioSql } from '../src/data/analytics-metrics.js';

const work = mkdtempSync(join(tmpdir(), 'claudescope-metrics-'));
process.env.DUCKDB_PATH = join(work, 'index.duckdb');
process.env.CLAUDESCOPE_HOME = join(work, 'home');

/** The expression as it was hand-written in analytics-sessions.ts before this. */
const LEGACY_SQL = `
  CASE
    WHEN (COALESCE(t.cache_read_tokens,0) + COALESCE(t.cache_write_tokens,0) + COALESCE(t.input_tokens,0)) > 0
    THEN COALESCE(t.cache_read_tokens,0)::DOUBLE
         / (COALESCE(t.cache_read_tokens,0) + COALESCE(t.cache_write_tokens,0) + COALESCE(t.input_tokens,0))
    ELSE 0
  END`;

/**
 * (cache_read, cache_write, input) — the edges worth pinning: a zero denominator
 * (must be 0, not NaN), a case that would truncate to 0 under integer division,
 * cache_write dominating (the reason it belongs in the denominator at all), and
 * NULLs, which only the SQL side can receive.
 */
const CASES: [number | null, number | null, number | null][] = [
  [0, 0, 0],
  [1, 0, 2],
  [1, 999, 0],
  [0, 0, 100],
  [100, 0, 0],
  [50, 25, 25],
  [null, null, null],
  [10, null, 30],
  [null, 5, 5],
  [1_000_000_000, 1, 1],
];

let conn: DuckDBConnection;
let closeConnection: () => Promise<void>;

beforeAll(async () => {
  const duck = await import('../src/db/duckdb.js');
  closeConnection = duck.closeConnection;
  conn = await duck.getConnection();
  await conn.run(
    'CREATE OR REPLACE TEMP TABLE t (i INTEGER, cache_read_tokens BIGINT, cache_write_tokens BIGINT, input_tokens BIGINT)',
  );
  const values = CASES.map(
    ([r, w, i], idx) => `(${idx}, ${r ?? 'NULL'}, ${w ?? 'NULL'}, ${i ?? 'NULL'})`,
  ).join(', ');
  await conn.run(`INSERT INTO t VALUES ${values}`);
});

afterAll(async () => {
  await closeConnection?.();
  rmSync(work, { recursive: true, force: true });
});

/** Evaluate an expression over the fixture table, ordered by row index. */
async function evaluate(expr: string): Promise<number[]> {
  const reader = await conn.run(`SELECT ${expr} AS v FROM t ORDER BY i`);
  return (await reader.getRowObjects()).map((r) => Number(r.v));
}

describe('cacheHitRatio: the TS and SQL encodings agree', () => {
  it('produces the same value for every case', async () => {
    const sql = await evaluate(
      cacheHitRatioSql('t.cache_read_tokens', 't.cache_write_tokens', 't.input_tokens'),
    );
    // NULL is the SQL-only input; COALESCE makes it 0, which is what the TS
    // callers pass after readRow's null→0 coercion.
    const ts = CASES.map(([r, w, i]) => cacheHitRatio(r ?? 0, w ?? 0, i ?? 0));
    expect(sql).toHaveLength(CASES.length);
    for (const [idx, expected] of ts.entries()) {
      expect(sql[idx], `case ${idx}: ${JSON.stringify(CASES[idx])}`).toBeCloseTo(expected, 12);
    }
  });

  it('matches the hand-written expression it replaced', async () => {
    const generated = await evaluate(
      cacheHitRatioSql('t.cache_read_tokens', 't.cache_write_tokens', 't.input_tokens'),
    );
    expect(generated).toEqual(await evaluate(LEGACY_SQL));
  });
});

describe('cacheHitRatio semantics', () => {
  it('is 0 — not NaN — when nothing was processed', () => {
    expect(cacheHitRatio(0, 0, 0)).toBe(0);
    expect(Number.isNaN(cacheHitRatio(0, 0, 0))).toBe(false);
  });

  it('counts cache writes as freshly processed', () => {
    // The bug the wrong header comment would have caused: omitting cache_write
    // pins a cache-priming session near 100% instead of ~0.1%.
    expect(cacheHitRatio(1, 999, 0)).toBeCloseTo(1 / 1000, 12);
    expect(cacheHitRatio(1, 999, 0)).not.toBe(1);
  });

  it('does not truncate to an integer', async () => {
    expect(cacheHitRatio(1, 0, 2)).toBeCloseTo(1 / 3, 12);
    const [sql] = await evaluate(
      `${cacheHitRatioSql('1::BIGINT', '0::BIGINT', '2::BIGINT')}`,
    );
    expect(sql).toBeCloseTo(1 / 3, 12);
  });
});
