# 0064 — MCP SDK v2 and `2026-07-28` stdio support

- **Status:** done
- **Date:** 2026-08-05
- **PR:** https://github.com/vladar107/claudescope/pull/85

## Context

The MCP `2026-07-28` protocol revision and the stable v2 TypeScript SDK have
shipped. ClaudeScope currently uses `@modelcontextprotocol/sdk@1.x` and opens a
`StdioServerTransport` directly, so it serves the initialize-based 2025 protocol
era only. That remains compatible with current clients, but a client pinned to
the new protocol era cannot connect.

The v2 SDK deliberately keeps a directly connected `McpServer` on the legacy
wire format. Supporting both eras over stdio requires the new `serveStdio`
entry point, not only a dependency bump. The official migration references are
the [v1-to-v2 guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
and the [`2026-07-28` support guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).

## Goal

Ship `claudescope mcp` on the stable v2 TypeScript SDK with both legacy 2025-era
and modern `2026-07-28` stdio compatibility, without changing its six tools,
lazy daemon startup, read-only behavior, or user configuration.

## Decisions

- **Use the split stable packages** — `@modelcontextprotocol/server` is a
  production dependency; `@modelcontextprotocol/client` is test-only. Remove
  `@modelcontextprotocol/sdk` rather than carrying v1 and v2 together.
- **Serve both protocol eras** — replace direct
  `server.connect(new StdioServerTransport())` with default `serveStdio(...)`.
  Do not set `legacy: 'reject'`; existing Claude, Codex, and other 2025-era
  clients must continue to connect.
- **Keep the current server factory and daemon boundary** — retain
  `createMcpServer(deps)` and keep the memoized, retryable `resolveClient`
  outside the stdio factory. The migration must not open DuckDB from the MCP
  process or start the daemon before the first tool call.
- **Adopt v2 schema objects explicitly** — wrap every tool `inputSchema` in
  `z.object(...)`, including the empty schema. Do not rely on v2's deprecated
  raw-shape compatibility overloads.
- **Keep the MCP surface unchanged** — no HTTP transport, MCP Apps, Tasks,
  sampling, elicitation, new tools, or output changes belong in this migration.
- **Validate both eras without adding a test suite** — the existing in-memory
  integration test remains the tool-behavior/legacy check; a bundled stdio smoke
  check performs a modern `server/discover` negotiation and `tools/list` because
  v2's `InMemoryTransport` does not exercise the `2026-07-28` era.

## Approach

1. **Dependency graph (simple; no prerequisites)** — replace the v1 SDK with
   `@modelcontextprotocol/server@^2.0.0`, add
   `@modelcontextprotocol/client@^2.0.0` as a server-workspace dev dependency,
   regenerate `package-lock.json`, and remove the root Hono override once
   `npm ls` confirms that dependency left the graph.
   Acceptance: no `@modelcontextprotocol/sdk` imports or manifest entries
   remain, and the resolved graph contains stable v2 packages with one
   compatible Zod 4 line.
2. **Dual-era stdio server (complex; depends on 1)** — move `McpServer` to the
   v2 root import, use `serveStdio` from the v2 stdio entry point, convert all
   six registration schemas to explicit Zod objects, and preserve the existing
   lazy daemon resolver and error mapping.
   Acceptance: the same six tools and descriptions are advertised to legacy
   clients, while a modern client negotiates `2026-07-28` successfully.
3. **Integration seam and distribution (simple; depends on 1-2)** — update the
   existing integration-test imports to the split client/server packages and
   confirm esbuild still inlines the MCP SDK so DuckDB remains the published
   artifact's only runtime dependency.
   Acceptance: the focused integration test passes unchanged in behavior, and
   `dist/package.json` still lists only `@duckdb/node-api`.
4. **Lockfile/Nix alignment and final validation (simple; depends on 1-3)** —
   refresh `flake.nix`'s `fetchNpmDeps` hash for the new lockfile, using the CI
   mismatch value because Nix is unavailable locally, then run the full
   validation and review pass.
   Acceptance: clean install, audit, tests, typecheck, build, bundle, legacy and
   modern stdio smoke checks, Nix CI, and CodeQL all pass.

## Files affected

- `packages/server/package.json` — replace the v1 SDK with v2 server/client
  packages in their production/test scopes.
- `packages/server/src/agent/mcp.ts` — update imports, schemas, and the stdio
  serving entry point while preserving tool and daemon behavior.
- `packages/server/test/mcp.integration.test.ts` — import the v2 client and a
  same-package linked `InMemoryTransport` pair; do not add new test cases.
- `package.json` — remove the v1 SDK's `@hono/node-server` override after
  verifying it is obsolete.
- `package-lock.json` — record the stable v2 dependency graph.
- `flake.nix` — update the dependency hash tied to the lockfile.
- `docs/plans/0064-mcp-sdk-v2.md` — keep status and final PR link current.
- `docs/plans/README.md` — index this plan and its status.

## Testing

1. Clean dependency verification:
   `npm ci --ignore-scripts`, then
   `npm ls @modelcontextprotocol/server @modelcontextprotocol/client zod` and
   `npm audit`.
2. Focused behavior check:
   `npm test -- packages/server/test/mcp.integration.test.ts`.
3. Full repository checks:
   `npm test`, `npm run typecheck`, `npm run build`, and `npm run bundle`.
4. Inspect `dist/package.json` and run the bundled `cli.js mcp` over stdio with
   temp-only ClaudeScope/source directories:
   - a legacy initialize client lists the same six tools;
   - a v2 client using modern version negotiation selects `2026-07-28` and
     lists the same six tools;
   - no protocol/debug text is written to stdout.
5. Push after local checks so CI can report the new `fetchNpmDeps` hash; update
   `flake.nix`, rerun CI, and require the Nix and CodeQL jobs to pass.
6. Review the final diff for accidental tool-contract, daemon-lifecycle,
   published-manifest, or unrelated dependency changes.

## Risks / open questions

- The v2 SDK is newly stable and may receive early patch releases. Reconfirm the
  latest stable 2.x release and migration notes immediately before changing the
  lockfile; do not consume prereleases.
- Direct `McpServer.connect(StdioServerTransport)` still compiles on v2 but
  silently remains legacy-only. The modern smoke check is therefore required;
  a successful typecheck or in-memory integration test is insufficient.
- The split packages alter the transitive graph and bundle composition. A clean
  install, audit, published-manifest inspection, and Nix hash refresh guard
  against stale modules or accidentally externalized runtime dependencies.
- No requirement is currently ambiguous or blocking. If `serveStdio` changes
  daemon laziness, process lifetime, or stdout behavior in practice, stop and
  reassess rather than compensating with unrelated lifecycle changes.
