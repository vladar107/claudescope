# 0035 — Roadmap: agent-facing access (MCP + CLI) & analytics depth

- **Status:** proposed
- **Date:** 2026-07-03
- **PR:** [#47](https://github.com/vladar107/claudescope/pull/47)

## Context

The backlog is fully caught up: plans 0001–0034 are all done (0024 abandoned in
favor of 0025), no open issues or PRs, no TODOs in the code. This document
records the outcome of a directions-brainstorm session: of the candidate
directions (more connectors, live session tailing, sharing/export, semantic
search), two tracks were selected to develop into a roadmap:

- **Track A — Agent-facing access:** expose transcript search/reading/analytics
  to agents (MCP server) and scripts (CLI query mode). Repositions Claudescope
  from a human viewer into memory infrastructure for coding agents ("have I hit
  this error before?").
- **Track B — Analytics depth:** exploit the uniquely multi-agent corpus —
  cross-agent comparison, code-impact metrics, error/interrupt signals, a
  week-in-review digest.

This is a roadmap, not an implementation plan: each slice below gets its own
`docs/plans/NNNN` plan when work starts, and this plan's status tracks the
roadmap as a whole.

## Goal

A sequenced, code-verified roadmap for both tracks: what to build, in what
order, with honest effort estimates, data-gap caveats, and the architectural
decisions that constrain the design.

## Decisions

- **MCP transport: stdio subcommand proxying the daemon's HTTP API** — decided
  by a hard constraint: `db/duckdb.ts` opens the index read-write
  (`DuckDBInstance.create`), and DuckDB allows one read-write process XOR
  multiple read-only ones, so a second process can never open the index while
  the daemon holds it. `claudescope mcp` auto-starts/adopts the daemon (reusing
  `readDaemon`/`isAlive`/`classifyExisting`/`start()` from `cli.ts`) and proxies
  everything to 127.0.0.1. Zero-precondition install:
  `claude mcp add claudescope -- claudescope mcp`. Rejected: direct DuckDB
  access from the MCP process (lock conflict, and it would duplicate fixes like
  the search `scalar_subquery` setting); streamable-HTTP `/mcp` as MVP (no
  client-driven autostart — deferred to a follow-up).
- **Token frugality is the real Track A work** — `GET /api/sessions/:id`
  returns full tool inputs/results for whole sessions (megabytes) and
  `GET /api/sessions` has no LIMIT; neither can be dumped into an agent
  context. Windowing, truncation, and plain-text snippets come first.
- **Redaction default off, opt-in flag** — loopback-bound single-user tool; the
  querying agent already has filesystem access to the transcript sources, so
  MCP/CLI output does not broaden the trust domain. Redaction matters when
  output leaves the machine (exports, digests) and stays one flag away.
- **One schema bump for all Track B index changes** — there is no migration
  pattern by design (schema-signature mismatch → full index rebuild), so
  `file_edits` and `tool_error_count` ship together in a single v10 bump: one
  rebuild for users, not two.
- **Code-impact extraction reuses `connector.loadSession()`** — for the six
  normalizing connectors, block-level data (edit contents, `is_error`) exists
  only via `loadSession()`, not in the flattened canonical NDJSON that SQL
  reads. Reusing the session-view path means apply_patch fan-out
  (Codex/opencode), Copilot's only-successful-edits rule, and Junie's
  full-file before/after all come free from normalization guarantees. Rejected
  for now: per-connector `.edits.ndjson` sidecars (faster rebuilds, but touches
  all 7 connectors — an optimization to revisit if rebuild cost demands it).
- **Data gaps render as n/a, never 0** — Antigravity has no tokens by design;
  Copilot tokens are session-level only; per-response metrics are only honest
  for claude-code/codex/pi/opencode. Every comparison surface must carry
  per-agent availability, establishing the presentation pattern all of Track B
  reuses.

## Approach

### Track A — MCP server + CLI query mode

MCP tool surface (6 tools), all thin shapers over the existing HTTP API:

| Tool | Purpose |
| --- | --- |
| `search_transcripts` | BM25 hits with plain-text snippets; query, project?, role?, scope? (sessions/memory/all), limit? |
| `list_sessions` | Compact `SessionMeta` rows; project?/agent?/sort?/limit? (default ~20) |
| `get_session` | Meta + windowed compact-markdown turn slice; offset/limit or around=<uuid>&radius, maxToolChars, redact? |
| `list_projects` | `ProjectMeta` rows |
| `get_analytics` | Existing `AnalyticsResponse` (groupBy project/model/day/agent, from/to) |
| `get_memory` | Global + per-project memory, bodies char-capped |

CLI subcommands on the same client: `claudescope search|sessions|session|projects|analytics`
— human tables by default, `--json` for scripts, ensure-daemon-running,
`--redact` opt-in. Later: `claudescope digest` (composes with Track B).

New dependency: `@modelcontextprotocol/sdk` (pure-JS dependency tree, no
natives) — esbuild inlines it into the existing `cli` entrypoint in
`scripts/bundle.mjs`; `@duckdb/node-api` stays the sole runtime dep. Import
only the `server/mcp.js` + `server/stdio.js` subpaths to keep the bundle lean.

### Track B — Analytics depth

- **B1. Cross-agent comparison (S, no schema change)** — same-project
  head-to-head per agent: cost, tokens/response, sessions, tool calls/response,
  cache ratio. Work = `project` filter on the analytics routes (or a dedicated
  `/api/analytics/agents?project=` route) + a comparison section in
  `AnalyticsPage.tsx`. Ride-alongs already indexed and unused:
  cost-per-PR-linked-session (`pr_links`; Claude-Code-only) and subagent-usage
  share (`is_sidechain`/`has_sidechain`).
- **B2. Code-impact metrics (L; M staged)** — LOC added/removed, files touched,
  most-edited files/dirs by project/agent/day. New `file_edits` table
  (deleted/reloaded per source file like `events` in `data/index.ts`),
  extraction via `loadSession()` + the changeset collector and LCS diff hoisted
  from web into `packages/shared`. Exact diff required (Junie stores whole
  files as old/new strings — newline counts would overcount by the whole
  file). Fork/resume duplicate edits need a canonical election analog to
  `electCanonicalUsage()` (dedupe by `(uuid, tool_use_id)`); sidechain edits
  included but flagged. This is agent-reported churn, not git truth — but the
  one metric where all 7 agents are on equal footing.
- **B3. Error/interrupt signals (S/M)** — interrupts: Claude Code's
  `[Request interrupted by user…]` is already in `events.text_content` (LIKE
  query; Claude-Code-only, labeled as such). Tool errors: `is_error` exists on
  canonical tool_result (claude-code/codex/opencode/copilot) but is not
  projected — add a `tool_error_count` canonical column via the v8
  `tool_names` playbook (`CANONICAL_EVENT_COLUMNS` in `connectors/types.ts`,
  SQL expr for Claude Code, TS count in the six normalizers). n/a for
  Junie/Antigravity. Schema part ships inside the B2 v10 bump.
- **B4. Digest (M, build last)** — composing route
  `/api/analytics/digest?from&to` over existing tables + `file_edits` (top
  projects, cost, streak via existing `computeStreaks`, tool mix, churn, error
  rate) + analytics-page section with "copy as Markdown" (export.ts
  precedent). Also surfaces as `claudescope digest`.

### Sequencing

| # | Slice | Effort | Why here |
| --- | --- | --- | --- |
| 1 | A1: API seams — session windowing, limits, plain snippets, shared redact/markdown | S | Unblocks everything in Track A; useful on its own |
| 2 | B1: Cross-agent comparison + ride-alongs | S | No schema risk, unique-selling-point payoff, establishes the n/a presentation pattern |
| 3 | A2: `claudescope mcp` MVP (6 tools) | M | The differentiator; ships the repositioning |
| 4 | A3: CLI query subcommands | S | Falls out of A2's client + shaping |
| 5 | B2+B3 schema: `file_edits` + `tool_error_count`, one v10 bump | L | The only index change, shipped once |
| 6 | B3 UI: error/interrupt analytics | S | Thin layer over v10 |
| 7 | B4: Digest (page + copy-md + `claudescope digest`) | M | Composition layer; both tracks feed it |
| 8 | Follow-ups: HTTP `/mcp` endpoint, MCP analytics/digest tools, MCP resources | S/M | After MVP feedback |

## Files affected

This PR: this document + the index row in `docs/plans/README.md` only.

Key seams for the eventual slices (verified during scoping):

- `packages/server/src/cli.ts` — daemon lifecycle helpers to reuse; new `mcp`
  and query subcommands.
- `packages/server/src/routes/sessions.ts`, `routes/search.ts` — windowing,
  limits, plain-text snippets.
- `packages/web/src/pages/session/export.ts` — `redactText` + the pure
  markdown renderer → `packages/shared`.
- `packages/web/src/pages/session/changeset.ts` +
  `packages/web/src/components/diff.ts` — changeset collector / LCS diff →
  `packages/shared` for index-time reuse.
- `packages/server/src/db/schema.ts` — v10: `file_edits` table,
  `tool_error_count` column; `data/index.ts` — extraction pass + fork dedup.
- `packages/server/src/connectors/types.ts` — canonical column contract.
- `packages/server/src/routes/analytics.ts` — pattern for the
  agents/impact/digest routes.
- `scripts/bundle.mjs` — inline `@modelcontextprotocol/sdk`.

## Testing

This PR is docs-only (`npm test` / `npm run typecheck` unaffected). Per slice,
at implementation time: integration fixtures per the repo test doctrine
(apply_patch fan-out, Copilot failed-edit exclusion, Junie full-content diff,
fork dedup for `file_edits`); rebuild-cost measurement with
`packages/server/perf/` before landing the v10 bump; MCP tools exercised
against a running daemon end-to-end.

## Risks / open questions

- **Autostart latency:** the first `claudescope mcp` launch triggers daemon
  spawn + initial index build — tools must return "index building" (via
  `/api/health.ready`), not hang; MCP clients spawn servers eagerly.
- **Version skew:** a freshly installed `claudescope mcp` may talk to an older
  running daemon — `/api/health.version` enables warn-or-restart (the
  `wedged`-replace logic in `start()` is a template).
- **Port discovery:** the MCP subcommand must read `daemon.json` for the
  actual port rather than assuming 4317.
- **Windowing semantics:** offset paging vs uuid-anchored windows — search
  hits return `messageUuid`, so anchoring `get_session` on it is the killer
  flow; decide one addressing scheme early in A1.
- **Rebuild cost of B2:** `loadSession()`-based extraction slows full rebuilds
  (incremental passes only touch changed files); if measurement says too slow,
  fall back to the per-connector sidecar design.
- **Churn ≠ git truth:** reverted/overwritten edits double-count in
  `file_edits`; label the metric as agent-reported activity.
- **Copilot permission-denials** count as `is_error` — decide whether to
  separate denials from real failures before shipping B3.
