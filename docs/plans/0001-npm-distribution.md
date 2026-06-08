# 0001 — npm distribution

- **Status:** done
- **Date:** 2026-06-08
- **PR:** (landed directly on `main`; pre-dates this plans convention — backfilled)

## Context

Claudescope was run-from-source only (`git clone` + `npm start`). We wanted to
ship it the standard way — via npm — so users can install and run it without the
repo. Three problems to solve: (1) how to deliver it, (2) how to start it once
and keep it running in the background, (3) how users update it.

Two blockers existed in the source layout:

- **State lived inside the package dir** (`DUCKDB_PATH`, `PRICING_PATH` under
  `PACKAGE_ROOT`). A global/npx install dir can be read-only and is wiped on
  upgrade, so the index and pricing edits wouldn't survive an update.
- **Monorepo of private workspaces** — not directly publishable as one tool.

## Goal

A single public npm package `@vladar107/claudescope` with a `claudescope` CLI
that runs the app as a background daemon, updates itself, and survives upgrades.

## Decisions

- **Scoped name `@vladar107/claudescope`** — kept the personal scope (no org
  needed; the scope is the username). Unscoped `claudescope` was available but
  the scope gives a stable namespace.
- **Background model: detached process + PID file** (not pm2, not an OS service).
  Cross-platform, no extra deps; `~/.claudescope/daemon.json` tracks it.
- **Package shape: bundle to one package** — esbuild inlines server + shared into
  one file; web build + default pricing + README copied alongside; workspaces
  stay private. Smallest install surface.
- **Releases are tag-only via CI** using npm **Trusted Publishing (OIDC)** — no
  long-lived `NPM_TOKEN`. Provenance is automatic.
- **State moved to `~/.claudescope/`** (override `CLAUDESCOPE_HOME`) so upgrades
  never wipe the index or pricing.

## Approach

1. Move runtime state out of the package dir to `~/.claudescope/`; seed
   `pricing.json` from a shipped default; resolve web/pricing paths for both dev
   and bundled layouts.
2. Add `scripts/bundle.mjs` (`npm run bundle`) to assemble the single package in
   `dist/`. Inject the version at bundle time; minify; no source maps.
3. Add the lifecycle CLI (`cli.js` bin): `start` (detached, idempotent), `stop`,
   `restart`, `status`, `logs`, `open`, `update` (npm i -g + restart), plus a
   cached daily update check. `help`/`version`.
4. Add the tag-triggered Release workflow (OIDC trusted publishing, provenance,
   tag-matches-version guard).
5. Docs: README install/CLI/state-dir/releasing; include README + keywords in the
   published manifest.

## Files affected

- `packages/server/src/config.ts` — `CLAUDESCOPE_HOME`, state paths, dev/bundled
  resolution, `ensureStateDir()`, version injection.
- `packages/server/src/index.ts` — call `ensureStateDir()` at boot.
- `packages/server/src/data/pricing.ts` — fall back to the shipped default.
- `packages/server/src/cli.ts` — the lifecycle CLI (new).
- `scripts/bundle.mjs` — the bundler/assembler (new).
- `.github/workflows/release.yml` — tag-triggered OIDC publish (new).
- `package.json` — `bundle` script, publish metadata, esbuild dev dep.
- `README.md` — npm install + CLI docs.

## Testing

- `npm test` (69 tests) + `npm run typecheck` green.
- End-to-end: `npm run bundle` → `npm pack ./dist` → `npm i -g` → `claudescope`
  serves the API + SPA, seeds `~/.claudescope`, and the daemon backgrounds /
  survives the parent shell; `stop` reaps it.
- Security review of the new surface (CLI spawns, PID handling, registry fetch):
  no exploitable findings; shipped deps had 0 audit vulnerabilities.

## Risks / open questions

- First release (`0.1.0`) was published manually to claim the name; subsequent
  releases go through the tagged CI workflow.
- Published bundle is minified (no source maps) — production stack traces are
  less readable; acceptable trade-off for size + not shipping source.
