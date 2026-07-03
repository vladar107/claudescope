# 0038 — `claudescope mcp`: agent-facing MCP server

- **Status:** done
- **Date:** 2026-07-03
- **PR:** [#50](https://github.com/vladar107/claudescope/pull/50)

## Context

Roadmap [0035](./0035-agent-access-and-analytics-roadmap.md), slice 3 (Track A).
Claudescope's transcript corpus is only reachable by humans through the web UI.
Exposing it to agents turns it into memory infrastructure: a coding agent can
ask "have I solved this before?" against its own history. Slice A1
([0036](./0036-agent-api-seams.md)) landed the token-frugality seams this
depends on: session windowing + `maxToolChars` on `/api/sessions/:id`, `limit`
on `/api/sessions`, `format=plain` search snippets, and the shared
`redactText`/`threadItemsToMarkdown` helpers.

## Goal

`claude mcp add claudescope -- claudescope mcp` works with zero preconditions
and gives an agent six read-only tools over the corpus, with outputs compact
enough to land in a context window.

## Decisions

- **Stdio subcommand proxying the daemon's HTTP API** — the DuckDB index is
  held read-write by the daemon and DuckDB allows only one such process, so a
  second process must never open the index file. Every tool call goes through
  a typed localhost `ApiClient`. (Per 0035; a streamable-HTTP `/mcp` endpoint
  on the daemon is a follow-up.)
- **Daemon ensured lazily on first tool use, not at MCP-server start** — MCP
  clients spawn servers eagerly at session start; deferring the spawn means
  `claudescope mcp` costs nothing until a tool is actually called. A failed
  ensure is retried on the next call instead of poisoning the session.
- **Daemon lifecycle factored to `daemon.ts`** — `readDaemon`/`isAlive`/
  `isHealthy`/`classifyExisting`/`spawnDaemon`/`ensureDaemon` are shared by
  cli.ts and the MCP server; cli.ts re-exports them so existing importers
  (tests) are unaffected. `ensureDaemon` writes only to stderr — stdout is the
  MCP protocol channel. On version skew (daemon ≠ CLI version) it warns and
  adopts; no auto-restart in this slice.
- **Text/Markdown tool output, not JSON dumps** — results land in an agent's
  context. `get_session` defaults to the first 20 turns with explicit paging
  info; tool payloads are capped at 2000 chars by default; memory bodies at
  2000 chars. Redaction is opt-in (`redact: true`), per 0035's stance for a
  loopback-bound single-user tool.
- **`@modelcontextprotocol/sdk` + `zod` inlined by esbuild** — only the
  `server/mcp.js` and `server/stdio.js` subpaths are imported so the SDK's
  HTTP stack (express/hono) stays out of the bundle. `@duckdb/node-api`
  remains the sole runtime dependency.

## Approach

1. `packages/server/src/daemon.ts` — factored lifecycle primitives +
   `spawnDaemon` + silent `ensureDaemon` (adopt / clear stale / replace wedged /
   spawn + wait, same semantics as `start`).
2. `packages/server/src/agent/api-client.ts` — typed fetch wrappers over the
   existing routes (health/projects/sessions/session/search/memory/analytics),
   reused by the CLI query subcommands in slice A3.
3. `packages/server/src/agent/mcp.ts` — `createMcpServer(deps)` with the six
   tools (`search_transcripts`, `list_sessions`, `get_session`, `list_projects`,
   `get_analytics`, `get_memory`); every handler resolves the client, returns a
   short "index is still building" note while `/api/health.ready` is false, and
   maps errors to MCP error results. `runMcpServer()` wires stdio + the
   memoized ensure-daemon resolver.
4. cli.ts: `mcp` command + help text; README "Agent access (MCP)" section.

## Files affected

- `packages/server/src/daemon.ts` — new; lifecycle primitives moved from cli.ts.
- `packages/server/src/cli.ts` — imports/re-exports daemon.ts, `mcp` command.
- `packages/server/src/agent/api-client.ts`, `agent/mcp.ts` — new.
- `packages/server/package.json` — `@modelcontextprotocol/sdk`, `zod`.
- `packages/server/test/mcp.integration.test.ts` — new.
- `README.md` — Agent access section.

## Testing

`npm test` / `npm run typecheck`. New integration suite boots the real Fastify
app on an ephemeral port against synthetic fixtures and drives the tools through
an SDK client over an in-memory transport: plain unescaped snippets, windowing +
truncation flowing through `get_session`, `around` anchoring, and the not-ready
degradation. Bundle smoke test: `npm run bundle`, then drive the bundled
`cli.js mcp` over stdio (initialize + tools/list) with `CLAUDESCOPE_HOME` and
all source dirs pointed at a temp sandbox.

## Risks / open questions

- Version skew adopt-and-warn may surprise after an upgrade (old daemon keeps
  serving); revisit auto-restart in a follow-up.
- The Nix flake's `npmDepsHash` changes with the new dependencies; if `nix` is
  unavailable locally the CI `nix` job flags the new hash to paste in.
- `get_session` defaults to the *first* 20 turns; an agent wanting "how did it
  end" pages via the reported total. A `tail`-style anchor could follow.
