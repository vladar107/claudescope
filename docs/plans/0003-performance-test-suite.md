# 0003 — Performance test suite (baseline + CI regression gate)

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-08
- **PR:** (landed directly on `main`)

## Context

We intend to add multi-agent support (Codex, …) by re-architecting ingestion
behind a connector seam. The biggest risk of that refactor is a **silent
performance regression**: today DuckDB parses the Claude JSONL **natively**
(`read_ndjson`, columnar, parallel) and does cost/text extraction in-engine.
Moving normalization into a TS connector layer could turn a fast native scan
into a slow per-line pipeline.

Before touching architecture we want a **measuring stick**: a suite that
captures today's hot-path performance and a CI gate that fails a change which
regresses it beyond a tolerance. The suite is also valuable on its own — it
catches perf regressions in ordinary development.

## Goal

A standalone perf harness over the real server hot paths, plus a **same-runner
A/B** CI gate that benches `main` and the PR back-to-back on the same VM and
fails if a *headline* metric regresses >10%.

## Decisions

- **Same-runner A/B, not a stored baseline.json** — a baseline committed from one
  CI run vs a future run compares two different VMs at different times; GitHub
  runners drift 10–30% with zero code change. Benching base and candidate on the
  same VM moments apart cancels that.
- **10% gate on headline metrics only** (cold-index events/sec, search p95, no-op
  reindex wall-clock) — 5% is below the timing noise floor; gating every
  micro-metric would flake.
- **Custom harness, not `vitest bench`** — scenarios need bespoke lifecycle (cold
  vs warm vs single-file-change) that fights tinybench's auto-iteration, and we
  need our own JSON output + compare/gate logic.
- **Deterministic seeded fixtures** so both A/B halves measure identical work.
- **Excluded from `npm test` and `npm run bundle`** — keep the unit suite fast and
  the shipped package clean.

## Approach

Scenarios (each calls the real function, warmup + median-of-N via
`process.hrtime.bigint()`):

| Scenario | Function under test | Metric |
| --- | --- | --- |
| Cold full index build | `reindex()` on empty DB | **events/sec, MB/sec**, wall-clock |
| No-op reindex | `reindex()` again, unchanged | **wall-clock** |
| Single-file-change reindex | touch one session file → `reindex()` | wall-clock |
| Search (BM25) | FTS query in `routes/search.ts` (warm, K runs) | **p95**, p50 |
| Session load + assemble | `loadSessionData()` + `assembleThread()`, large session | wall-clock |
| Analytics | aggregation in `routes/analytics.ts`, per `groupBy` | wall-clock |

Headline (CI-gated) metrics are bolded; the rest are informational.

Isolation reuses the integration pattern: set `CLAUDE_PROJECTS_DIR`,
`DUCKDB_PATH`, `CLAUDESCOPE_HOME`, `REINDEX_INTERVAL_MS=0` to temp dirs **before**
dynamically importing server modules (mirrors
`packages/server/test/api.integration.test.ts:17-26`). Cold-build deletes the DB
first; temp dir removed at the end.

## Files affected

- `packages/server/perf/fixtures.ts` — seeded parametric corpus generator,
  extending `jsonl()`/`writeFixtures()` (`api.integration.test.ts:27-80`).
- `packages/server/perf/scenarios.ts` — the six scenarios, reusing `reindex()`
  (`data/index.ts:315`), search SQL (`routes/search.ts:85`), `loadSessionData()`
  (`data/session-loader.ts:134`) + `assembleThread()` (`data/parser.ts:53`),
  analytics SQL (`routes/analytics.ts:65`), `getConnection()`/`queryRows()`
  (`db/duckdb.ts`).
- `packages/server/perf/run.ts` — harness entry (`--scale`, `--runs`, `--out`):
  env → corpus → scenarios → results JSON + human table.
- `packages/server/perf/compare.ts` — diff base vs candidate JSON, 10% tolerance
  on headline metrics, non-zero exit on regression. No-ops if base is missing
  (bootstrap: `main` predates the suite).
- Root `package.json` — `bench` and `bench:compare` scripts (via `tsx`).
- `.github/workflows/perf.yml` — PR-only same-runner A/B job (Node 20): bench PR
  head, bench `main` (second checkout at `base/`), compare, upload both JSONs.
- `packages/server` tsconfig — ensure `perf/` typechecks without entering the
  `tsc -b` build output or the bundle.

## Testing

- `npm run bench` → prints table, writes results JSON, exit 0.
- Run twice, `npm run bench:compare` no-change → ~0% deltas, exit 0.
- Inject a slowdown → compare exits non-zero and names the regressed headline
  metric (then revert).
- `npm test` unaffected (perf files are not `*.test.ts`); `npm run typecheck`
  passes incl. `perf/`; `npm run bundle` output unchanged.

## Risks / open questions

- Residual CI jitter — mitigated by same-runner A/B + median-of-N + headline-only
  10% gate.
- Bootstrap: the introducing PR has no base harness to compare against; the
  compare step no-ops on a missing base, then every later PR gets a real gate.
- This is wall-clock of real DuckDB ops, not CPU-instruction microbenchmarks —
  intentional: it's the metric the re-architecture must not regress.
- Follow-up: the multi-agent discovery doc + connector-seam plan should carry
  "no >10% regression on headline metrics" as an explicit acceptance criterion.
