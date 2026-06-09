# 0004 — Connector seam: extract Claude ingestion behind an `AgentConnector` port

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-08
- **PR:** (branch `feat/multi-agent-connectors`)

## Context

We want Claudescope to support multiple coding agents (Codex next). The codebase
was coupled to Claude Code's format almost entirely in **ingestion**:
`data/index.ts` read the Claude JSONL natively via `read_ndjson` and extracted
Claude-specific JSON paths (`message.role/model`, `message.usage.*`,
`$.content[]` text/thinking blocks, `isSidechain`, ai-title/pr-link) directly in
SQL, and `data/session-loader.ts` knew the Claude subagent layout.

This step is a **pure refactor — no behavior change, no new format, no schema
change.** It extracts the Claude-specific ingestion/loading behind an
`AgentConnector` port so the indexer orchestrates a connector registry over the
**canonical `events` schema**, ready for a `CodexConnector` to be added next.

## Goal

A format-agnostic indexer + session loader behind a one-implementation
(`claude-code`) connector registry, with **identical behavior and performance**.

## Decisions

- **Normalize by SQL projection, not TS objects.** A connector hands back a
  `SELECT` that reads its raw file (its own `read_ndjson` map) and projects into
  the canonical event columns; the indexer wraps it with the central cost
  expression. DuckDB keeps doing the work natively → no hot-path move into TS →
  perf unchanged (verified: cold-index throughput +0.1%).
- **Canonical `events` schema is the boundary.** `rebuildSessions`,
  `rebuildFtsIndex`, and `buildCostExpr` already operated only on canonical
  columns, so they stayed central untouched.
- **No DB schema change now.** Single connector; `connectorForSession` returns
  it unconditionally. `files.connector_id` + multi-source discovery are deferred
  to the Codex step (only needed to disambiguate a second source) — avoids any
  index migration.
- **SQL moved verbatim**, not rewritten, so executed queries are identical.

## Approach

New `src/connectors/`:
- `types.ts` — `AgentConnector` (`discover` / `eventsProjectionSql` /
  `auxProjections` / `loadSession`), `DiscoveredFile`, `CANONICAL_EVENT_COLUMNS`.
- `claude-code.ts` — all Claude-format knowledge: discovery, the projection +
  text/tool exprs, ai-title/pr-link aux, and session/subagent loading.
- `registry.ts` — `connectors` + `connectorForSession`.

`data/index.ts` now: discover across the registry → change-detect (unchanged) →
generic `loadFile` (central cost + canonical columns wrapping
`connector.eventsProjectionSql`) → central `rebuildSessions` + `rebuildFtsIndex`.
`data/session-loader.ts` resolves a session's files then delegates to
`connector.loadSession`. Public surface (`reindex`, `isIndexReady`,
`loadSessionData`) and `routes/*` unchanged.

Also hardened the perf gate found flaky during verification: `perf/compare.ts`
now applies a **significance floor** (`--min-ms`, default 25) so latency metrics
in the noise (e.g. the ~2.5ms no-op reindex) are reported but never gated.

## Files affected

- `src/connectors/types.ts`, `src/connectors/claude-code.ts`,
  `src/connectors/registry.ts` *(new)*.
- `src/data/index.ts` *(rewritten orchestration; cost/derived/FTS verbatim)*.
- `src/data/session-loader.ts` *(types + thin delegator)*.
- `perf/compare.ts` *(significance floor for the regression gate)*.

## Testing

- `npm run typecheck` ✓; `npm test` ✓ (69 pass — the integration suite is the
  behavior-parity oracle).
- `grep -nE "json_extract|read_ndjson\\(|\\$\\." src/data/index.ts` → clean; all
  18 extraction markers now live in `claude-code.ts`.
- `npm run bench` + `bench:compare` vs `main` (same machine): cold-index
  throughput **+0.1%**, no headline regression. Synthetic regression still
  fails (exit 1). The PR's `perf.yml` A/B is the CI enforcement.

## Risks / open questions

- None functional — behavior and perf are unchanged by construction.
- Follow-up `0005`: add `CodexConnector`
  (`~/.codex/sessions/**/rollout-*.jsonl`, heterogeneous line types, `call_id`
  pairing, reasoning tokens, OpenAI pricing) + the `files.connector_id` column +
  multi-source discovery, under the same perf gate.
