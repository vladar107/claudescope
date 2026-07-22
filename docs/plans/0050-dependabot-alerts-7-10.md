# 0050 — Dependabot alerts #7–#10 remediation

- **Status:** in-progress
- **Date:** 2026-07-22
- **PR:** https://github.com/vladar107/claudescope/pull/68

## Context

The dependency-graph scan after PR #67 surfaced four pre-existing Dependabot
alerts across three packages: `shell-quote@1.8.4` (high),
`@hono/node-server@1.19.14` (medium), and two high-severity advisories affecting
`fast-uri@3.1.2`. All three versions were already present immediately before
PR #67; that PR changed only `brace-expansion`.

The vulnerable packages are transitive. Their current direct parents require
different remediation strategies: the latest `concurrently` pins vulnerable
`shell-quote`, while the latest MCP SDK depends on the vulnerable Hono adapter.

## Goal

Clear Dependabot alerts #7–#10, preserve Claudescope's runtime and development
workflows, and keep the Nix dependency cache in sync.

## Decisions

- **Downgrade `concurrently` to `9.2.4`** — this release depends directly on
  patched `shell-quote@1.9.0`; `concurrently@10.0.3` pins the vulnerable release.
- **Keep `@modelcontextprotocol/sdk@1.29.0` and override only
  `@hono/node-server` to `2.0.11`** — downgrading the SDK to `1.24.3` removes
  Hono but reintroduces two high-severity SDK advisories. The latest SDK still
  constrains Hono to vulnerable `1.x`, so the patched major is the only graph
  that clears all findings. `2.0.11` also includes the fix for a newer Hono
  WebSocket-handshake memory leak affecting `2.0.5–2.0.9`. Claudescope uses the
  SDK's stdio APIs rather than Hono's HTTP surface, covered by integration tests.
- **Resolve `fast-uri@3.1.4` within existing parent ranges** — no direct
  dependency or override is needed.
- **Refresh the Nix dependency hash** — the changed lockfile alters the fixed
  output produced by `fetchNpmDeps`; CI will print the new hash because Nix is
  unavailable on the development machine.

## Approach

1. Downgrade the direct development dependency, add the targeted Hono override,
   and regenerate `package-lock.json`.
2. Confirm `shell-quote@1.9.0`, `@hono/node-server@2.0.11`, and
   `fast-uri@3.1.4` in the resolved tree; require `npm audit` to report zero.
3. Run tests, typecheck, and the production build, with MCP integration coverage
   validating the Hono override under the current SDK.
4. Push the PR, obtain the new Nix hash from the Linux/macOS CI mismatch, update
   `flake.nix`, and confirm the replacement CI run.

## Files affected

- `package.json` — use the non-vulnerable `concurrently` release and override
  the MCP SDK's vulnerable Hono adapter.
- `package-lock.json` — resolve the patched dependency graph.
- `flake.nix` — refresh the fixed-output hash after CI computes it.

## Testing

Run `npm audit`, `npm ls fast-uri shell-quote @hono/node-server`, `npm test`,
`npm run typecheck`, `npm run build`, and the Linux/macOS Nix CI jobs.

## Risks / open questions

- `concurrently` moves back one major line until its latest release adopts the
  patched transitive. The Hono override crosses a major version, but that HTTP
  adapter is not imported by Claudescope's stdio MCP server; MCP integration
  tests guard the SDK surface Claudescope uses.
- Local Nix verification is unavailable; the PR CI jobs are the authoritative
  fixed-output hash and cross-platform build verification.
