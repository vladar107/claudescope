# 0040 — CLI query subcommands

- **Status:** done
- **Date:** 2026-07-03
- **PR:** [#51](https://github.com/vladar107/claudescope/pull/51)

## Context

Roadmap slice 4 of [0035](./0035-agent-access-and-analytics-roadmap.md). Slice
A2 (plan [0038](./0038-mcp-server.md)) built the agent-facing plumbing — the
typed `ApiClient` over the daemon's HTTP API, `ensureDaemon()`, and the MCP
tools' output shaping. This slice exposes the same read-only lookups to
terminals and scripts as CLI subcommands, so transcript history is one `grep`
away and `--json` pipes into `jq`.

## Goal

`claudescope search|sessions|session|projects|analytics` — human tables /
compact Markdown by default, raw JSON with `--json`, auto-starting the daemon,
sharing one shaping layer with the MCP tools.

## Decisions

- **Shared shaping module (`agent/shape.ts`)** — the search-hit and
  session-Markdown renderers moved out of `agent/mcp.ts` into a new pure module
  used by both the MCP tools and the CLI, instead of duplicating them. Tables,
  however, are CLI-only (`agent/query.ts`): MCP output stays list-shaped for
  agent contexts, terminals get pad-aligned columns.
- **`--json` = the raw API response** — no redaction, no clipping beyond what
  request params ask for. Machine output should be the contract type, not a
  shaped view; `--redact` applies to the human Markdown only (documented in
  help/README).
- **Flag validation before daemon spawn** — `runQuery(prepare)` runs the flag
  parsing first, so `--limit banana` errors out without starting anything.
- **Session windowing defaults match MCP** — no windowing flags → the first 20
  turns with a paging line, `--max-tool-chars` default 2000. A huge session
  never dumps whole by accident.
- **Dependency-free tables** — code-unit `padStart`/`padEnd` alignment with a
  60-char clip on free-text columns. Wide-glyph (emoji/CJK) alignment is
  imperfect by design; correctness (row present, nothing crashes) over
  typography.

## Approach

1. Extract `shapeSearchResults` + `shapeSessionMarkdown` (and the small fmt
   helpers/defaults) from `agent/mcp.ts` into `agent/shape.ts`; mcp.ts
   re-imports.
2. New `agent/query.ts`: `querySearch` / `querySessions` / `querySession` /
   `queryProjects` / `queryAnalytics`, each `(client, args) → Promise<string>`
   so tests inject a fixture-app client; plus the `table()` helper.
3. `cli.ts`: new flags in the single `parseArgs` table, `runQuery()` wrapper
   (validate flags → `ensureDaemon()` → `ApiClient` → print; errors to stderr,
   exit 1), five dispatch cases, help text.
4. README: "Scripting (CLI)" subsection under Agent access with jq examples.

## Files affected

- `packages/server/src/agent/shape.ts` — new; shaping shared by MCP + CLI.
- `packages/server/src/agent/query.ts` — new; the five subcommands + `table()`.
- `packages/server/src/agent/mcp.ts` — imports the extracted shaping; behavior
  unchanged (existing MCP tests untouched).
- `packages/server/src/cli.ts` — flags, `runQuery`, dispatch, help.
- `README.md` — Scripting subsection.
- `packages/server/test/cli-query.test.ts` — new integration tests.

## Testing

`npm test` (344 passing, 5 new) and `npm run typecheck` clean. New tests boot
the real app on an ephemeral port over synthetic fixtures and cover the
CLI-specific edges: table alignment with a clipped long title and a non-ASCII
title, `--json` passthrough (raw rows; `window` metadata; redact ignored),
`--redact` masking home paths in Markdown output, empty-result "No matches."
as normal output, and the analytics totals line.

## Risks / open questions

- Table alignment is code-unit based; emoji/CJK-heavy titles can look ragged.
  Acceptable for a listing; revisit only if it bothers real use.
- `--q` relies on `parseArgs` accepting single-char long option names (verified
  on the pinned Node).
- A `tail`-style anchor for `session` (open the END of a session) is a natural
  follow-up, same as noted for MCP `get_session` in 0038.
