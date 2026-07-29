/**
 * The canonical column contract, enforced.
 *
 * Every connector's `eventsProjectionSql` has to emit the same columns, because
 * `loadFile` selects them by name into `events`. That contract used to be
 * restated by hand three times per connector (a row interface, a `read_ndjson`
 * column map, and a SELECT list) with nothing checking they agreed — a documented
 * `CANONICAL_EVENT_COLUMNS` array existed but was never read by anything. Adding
 * a column therefore meant editing ~16 lists, and a miss produced silently wrong
 * data rather than a type error.
 *
 * Six of the connectors now generate their projection from `CANONICAL_COLUMNS`,
 * so they cannot drift. Claude Code's is still hand-written (it reads raw JSONL
 * with a LATERAL block aggregate rather than a normalized cache), which makes it
 * the one that CAN drift — and the main reason this test exists.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'claudescope-contract-'));
process.env.CLAUDESCOPE_HOME = join(work, 'home');

const { connectors } = await import('../src/connectors/registry.js');
const { CANONICAL_COLUMNS } = await import('../src/connectors/canonical.js');

/** Columns `loadFile` selects on top of the canonical set. */
const EXTRA = ['message_id', 'forked_from_session_id'];

/**
 * Output column names of a projection's top-level SELECT list.
 *
 * Paren-depth aware on both boundaries: Claude Code's projection nests a
 * `FROM json_each(...)` inside a LATERAL join and puts commas inside CASE
 * expressions, so naive splitting picks up the subquery's columns instead.
 */
function selectedColumns(sql: string): string[] {
  const flat = sql.replace(/\s+/g, ' ');
  const start = flat.indexOf('SELECT ') + 7;
  let depth = 0;
  let end = flat.length;
  for (let i = start; i < flat.length; i++) {
    const ch = flat[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && flat.startsWith(' FROM ', i)) {
      end = i;
      break;
    }
  }
  const body = flat.slice(start, end);
  const out: string[] = [];
  depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((expr) => {
    const e = expr.trim();
    const aliased = /\sAS\s+([A-Za-z_][\w]*)$/i.exec(e);
    if (aliased) return aliased[1]!.toLowerCase();
    return (e.split('.').pop() ?? e).toLowerCase();
  });
}

describe('every connector projects exactly the canonical columns', () => {
  const expected = [...Object.keys(CANONICAL_COLUMNS), ...EXTRA].sort();

  it.each(connectors.map((c) => c.id))('%s', (id) => {
    const c = connectors.find((x) => x.id === id)!;
    // A path is enough: the SQL is built from it, never read here.
    const sql = c.eventsProjectionSql('/tmp/does-not-exist/session.jsonl');
    expect(selectedColumns(sql).sort()).toEqual(expected);
  });
});

describe('CANONICAL_COLUMNS matches the events table it feeds', () => {
  it('names only columns that exist in the events schema', async () => {
    const { SCHEMA_DDL } = await import('../src/db/schema.js');
    const eventsDdl = SCHEMA_DDL.find((d) => d.includes('CREATE TABLE IF NOT EXISTS events'))!;
    for (const col of [...Object.keys(CANONICAL_COLUMNS), ...EXTRA]) {
      // A column the projection emits but `events` lacks would fail every load.
      expect(eventsDdl, `events is missing '${col}'`).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });
});

process.on('exit', () => rmSync(work, { recursive: true, force: true }));
