# 0039 — Code-impact index: `file_edits` + `tool_error_count` (schema v10)

- **Status:** done
- **Date:** 2026-07-03
- **PR:** [#52](https://github.com/vladar107/claudescope/pull/52)

## Context

Roadmap [0035](./0035-agent-access-and-analytics-roadmap.md), sequencing row 5
(Track B slices B2+B3, the schema part). Code-impact metrics (LOC churn, files
touched) need edit data *indexed*, not assembled per-session at read time; tool
failure rates need `is_error` *projected*, not buried in raw blocks. Both are
index changes, and a schema-signature mismatch rebuilds the whole index, so
they ship in one v10 bump — one rebuild for users.

## Goal

A `file_edits` table (one row per canonical Edit/MultiEdit/Write call, with
exact LCS add/del counts, fork-deduped) plus a nullable
`events.tool_error_count` column, and a minimal `/api/analytics/impact` route
over them. UI arrives in roadmap rows 6–7.

## Decisions

- **Extraction reuses `connector.loadSession()`** (roadmap option A): the
  indexer re-runs the exact session-view path (load → assemble → shared
  changeset collector) for sessions touched by a pass, so every normalization
  guarantee (apply_patch fan-out, Copilot only-successful-edits, Junie
  full-file before/after) holds for free. Rejected for now: per-connector
  `.edits.ndjson` sidecars (faster, but touches all 7 connectors).
- **Session-scoped delete/reload, not per-file** — a deviation from the
  roadmap's `source_file` sketch: the extraction unit is the session (its edits
  span main + subagent files), so rows key on `session_id` and the indexer
  collects the touched session set (loaded files + removed files' sessions) and
  re-extracts those wholesale. A `source_file` column would be arbitrary for
  multi-file sessions and adds nothing to incremental correctness.
- **Exact LCS diff, not line-count approximations** — Junie stores the whole
  file as `old_string`/`new_string`; approximations would overcount by the
  file size. `Write` counts as pure additions (matching the Files-changed tab).
- **Fork dedup mirrors `electCanonicalUsage`** — fork copies preserve `uuid` +
  `tool_use_id`, so `edit_canonical` is elected globally per
  `(uuid, tool_use_id, file_path)`, preferring rows whose events carry no
  `forkedFrom` marker. Rows are kept (not deleted) so deleting the original
  file re-elects the surviving fork copy. Synthetic uuids are session-prefixed
  in every connector, so cross-session collisions can't false-positive.
- **`tool_error_count` is NULL when unknowable, never 0** — Junie (results are
  `modified: path` strings) and Antigravity (typed records carry no error
  signal) emit NULL; claude-code counts in SQL, codex/pi/opencode/copilot count
  in TS at normalize time (the v8 `tool_names` playbook). Copilot
  permission-denials currently count as errors — open question below.
- **One LATERAL block scan in the Claude projection** — adding a fourth
  correlated `json_each` subquery per row regressed cold indexing ~20%
  (interleaved A/B, over the 10% CI gate). The four block aggregates
  (text, tool_use count, tool names, tool errors) now come from a single
  `LEFT JOIN LATERAL` scan, which benches at parity or slightly better than
  the pre-v10 baseline.

## Approach

1. Hoist the changeset collector to `packages/shared/src/changeset.ts`
   (per-call `collectEditCalls` with `(uuid, toolUseId)` addressing;
   `buildChangeset` rebuilt on top; web re-imports via a shim).
2. Schema v10 (`db/schema.ts`): `file_edits` table + index, nullable
   `events.tool_error_count` appended last (positional INSERT stays aligned).
3. `tool_error_count` through the seam: `CANONICAL_EVENT_COLUMNS` +
   `connectors/tool-errors.ts` helper + all seven connectors.
4. Extraction (`data/file-edits.ts`): `refreshFileEdits` (delete + re-extract
   per touched session, `tool_names` LIKE pre-filter so edit-free sessions are
   never parsed, per-session failure isolation) and `electCanonicalEdits`;
   wired into `doReindex` after `electCanonicalUsage`.
5. Route `GET /api/analytics/impact?groupBy=agent|day|file&project=&from=&to=`
   (`routes/analytics-impact.ts`; `file` capped at 200 rows). Types in
   `shared/src/api.ts`. **No UI in this slice** — roadmap rows 6–7 consume it.

## Files affected

- `packages/shared/src/changeset.ts` (new), `diff.ts` consumers, `api.ts`
  (Impact types); `packages/web/src/pages/session/changeset.ts` → shim.
- `packages/server/src/db/schema.ts` — v10.
- `packages/server/src/connectors/` — `types.ts`, `tool-errors.ts` (new),
  claude-code LATERAL projection, six normalizers + projections.
- `packages/server/src/data/` — `file-edits.ts` (new), `index.ts` wiring.
- `packages/server/src/routes/` — `analytics-impact.ts` (new), `index.ts`.

## Testing

`packages/server/test/file-edits.integration.test.ts` (9 tests, fixture-built
index per repo doctrine): Codex apply_patch fan-out lands per-file rows with
exact counts; fork copies stored but only the original canonical; Junie
full-file before/after → exact one-line diff; Copilot denied edit excluded;
`tool_error_count` NULL for Junie vs counted for Claude/Codex; impact route
grouping/filtering; incremental re-extraction (clean replace, no dupes) and
re-election after the original file is deleted. Shared collector edges in
`packages/shared/test/changeset.test.ts` (moved from web). Full suite: 344
passing; `tsc -b` clean.

Perf (interleaved A/B, `npm run bench`, 2 cycles × 3 runs): cold index
859–863 ms (v10) vs 882–922 ms (base); no-op and single-file reindex unchanged.
The naive correlated-subquery version regressed ~20% — caught and fixed by the
LATERAL fold before landing.

## Risks / open questions

- Copilot permission-denials count in `tool_error_count`; whether to split
  "denied" from "failed" is deferred to the error-analytics UI slice (row 6).
- Churn is agent-reported, not git truth: reverted/overwritten edits count
  each time — documented on the route and types.
- The impact route duplicates the small project-slug resolution loop used by
  analytics routes on parallel branches; worth a shared helper once both land.
