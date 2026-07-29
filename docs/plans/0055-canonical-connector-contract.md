# 0055 — One canonical connector contract instead of sixteen

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-29
- **PR:** https://github.com/vladar107/claudescope/pull/75

## Context

Fourth PR from the repo-wide review (after [0052](./0052-indexer-durability-and-state-perms.md),
[0053](./0053-validate-query-params.md), [0054](./0054-daemon-pid-ownership-and-port.md)).
Unlike those, this fixes no user-visible defect — it removes the maintenance
hazard that made the earlier ones easy to introduce.

Seven connectors normalize a session to a canonical NDJSON and hand the indexer a
`SELECT` that reads it back. That one contract was restated **three times per
connector**:

| duplicated thing | copies |
| ---------------- | -----: |
| `eventsProjectionSql` (16 lines; differ only by the `provider` column) | 7 |
| `interface CanonicalRow` (differ only by optional `provider` / `title`) | 7 |
| `CACHE_DIR` + `cachePath()` + `prepare()` | 7 |
| `str` / `num` / `rec` coercion helpers | 7 |
| `auxProjections` titles block (verbatim) | 4 |

Nothing checked that the 21 columns agreed. `CANONICAL_EVENT_COLUMNS` in
`types.ts` *looked* like the contract but was **dead** — grepping the whole
monorepo found only its own declaration and one JSDoc reference. So adding
`tool_error_count` in schema v10 meant editing ~16 hand-maintained lists, and a
miss produces silently wrong data (a NULL column, a zeroed metric) rather than a
type error.

## Goal

The canonical contract has exactly one definition, the row type / column map /
SELECT list are all derived from it, and a test fails if any connector drifts.

## Decisions

- **Generate from a name→type map, don't just extract the string** — the obvious
  refactor is one shared SQL template. But the column map and the SELECT list are
  two views of the same contract, and a template still lets them disagree.
  `CANONICAL_COLUMNS` is data, and both views are computed from it.
- **Leave Claude Code's projection hand-written** — it reads raw JSONL with its
  own column map plus a LATERAL block aggregate, has no cache file and no
  canonical row. Forcing it through the shared generator would mean
  parameterizing away everything that makes it different. It is therefore the one
  connector that *can* still drift, which is the main reason the new contract test
  exists.
- **Prove SQL equivalence mechanically, not by reading the diff** — captured
  every connector's generated `eventsProjectionSql` + `auxProjections` before the
  change, then compared column maps and SELECT lists after. A refactor whose whole
  risk is "silently wrong data" needs a mechanical check, not eyeballing 457
  deleted lines.
- **Unify `rec` on the stricter variant** — five copies rejected arrays, two
  accepted them. Confirmed first that every call site only reads a property off
  the result (never spreads or iterates it), which makes the two
  indistinguishable: `[].field` and `{}.field` are both `undefined`.
- **Leave `zeroUsage` alone** — the four copies look duplicated but the types
  genuinely diverge: Codex's deliberately omits `cache_creation_input_tokens`, and
  Junie's needs an index signature for delta accumulation. Unifying two of four
  would add an import without removing the hazard.
- **Don't export `CACHE_ROOT` "for later"** — the cache GC in the next PR will
  want it, but shipping an unused export is the exact habit
  `CANONICAL_EVENT_COLUMNS` demonstrated. Export it when something reads it.

## Approach

1. `connectors/canonical.ts` — `CANONICAL_COLUMNS`, the shared `CanonicalRow`,
   `canonicalProjectionSql()`, `titlesProjectionSql()`.
2. `connectors/ndjson-cache.ts` — `ndjsonCache(agentId)` owning the cache layout.
3. `connectors/json.ts` — `str` / `num` / `rec`.
4. Migrate the seven cache-backed connectors; delete the dead const in `types.ts`
   and point its doc at the live contract.
5. `test/canonical-contract.test.ts` — assert every connector (Claude Code
   included) projects exactly the canonical column set, and that every canonical
   column exists in the `events` DDL.

## Files affected

- `packages/server/src/connectors/canonical.ts`, `ndjson-cache.ts`, `json.ts` — new.
- `packages/server/src/connectors/{codex,junie,pi,opencode,copilot,antigravity,grok}/{*.ts,normalize.ts}`
  — use the shared helpers.
- `packages/server/src/connectors/types.ts` — drop the dead const.
- `packages/server/test/canonical-contract.test.ts` — new.

## Testing

- `npm test` (545 → 554), `npm run typecheck`, `npm run build`, markdownlint.
- **Equivalence**: captured generated SQL before/after; column maps, SELECT lists
  and aux projections are equivalent for all eight connectors (text differs only
  in whitespace, and Claude Code's is byte-identical).
- **Contract enforcement verified in both directions**: removing a column from
  Claude Code's hand-written projection fails its case; adding one to
  `CANONICAL_COLUMNS` without adding it to the `events` DDL fails the schema case.
- The per-connector integration suites (`codex`, `pi`, `grok`, `copilot`,
  `junie`, `opencode`, `antigravity`) are the behavioural net and all still pass.

## Risks / open questions

- The index is a derived cache, so even a missed column self-heals on rebuild —
  but it would serve wrong analytics until then. Hence the equivalence check.
- The shared generator emits columns in `CANONICAL_COLUMNS` order. `loadFile`
  selects by name, so order is not load-bearing today; the contract test would
  catch a set change but not a reorder.
- Claude Code remains the drift risk by design. The contract test covers its
  column set, not its expressions.
