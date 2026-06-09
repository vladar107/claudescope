# Agent Guide

This is the source of truth for working in this repository — architecture, commands, conventions, and gotchas.

## Quick Essentials

- Never write to `~/.claude` — it's the read-only data source. App state lives in `~/.claudescope/` (override: `CLAUDESCOPE_HOME`).
- Run `npm test` and `npm run typecheck` after changes.
- Conventional Commits; no AI co-author trailers; keep linear history.
- When you do non-trivial work, commit a plan under `docs/plans/` and link it in the PR (see `docs/plans/README.md`).

## Architecture

This is an npm-workspaces monorepo with the following packages:

- `packages/shared`: TypeScript types — the API and data contract shared by server and web.
- `packages/server`: Fastify API with DuckDB index (`@duckdb/node-api`); serves the built UI.
- `packages/web`: Vite + React UI (react-markdown, Shiki, Recharts).

The server serves both the API and the built SPA on one port (4317). DuckDB reads JSONL natively (`read_ndjson`) for indexing, full-text search, and analytics. A TypeScript parser assembles the threaded view for a single session. The DuckDB index is a derived cache — fully rebuildable from the JSONL. If it's corrupt, the app discards and rebuilds it.

## Runtime State — Critical

- **NEVER write to `~/.claude`.** It is the read-only data source.
- All app-owned state lives in **`~/.claudescope/`** (override: `CLAUDESCOPE_HOME`): the DuckDB index, a user-editable `pricing.json` (seeded from a shipped default; `loadPricing` falls back to the default if the copy is missing), the daemon PID file, and logs. State lives outside the package dir so global installs survive upgrades — do not move it back into the package.

## Commands

```bash
npm install         # install workspace deps
npm run dev         # server (watch) on :4317 + Vite dev server on :5317 (HMR)
npm start           # build (first run) + serve in the foreground
npm run build       # production build (shared → web → server)
npm test            # Vitest (run once)   |  npm run test:watch
npm run typecheck   # tsc -b across all packages
npm run bundle      # assemble the single publishable package into dist/
```

The shipped CLI (after install) is `claudescope {start|stop|status|restart|logs|open|update}`.

## Distribution Model

`npm run bundle` (`scripts/bundle.mjs`) produces the published artifact in `dist/`: esbuild bundles the server and CLI (shared lib inlined) into two minified, source-map-free files; the web build, a default `pricing.json`, and `README.md` are copied alongside; a self-contained `package.json` is generated whose only runtime dependency is the native `@duckdb/node-api`. The version is injected at bundle time via esbuild `define` (`__CLAUDESCOPE_VERSION__`) — never hardcode it. Publish metadata (keywords, repo, etc.) is sourced from the root `package.json`; edit it there, not in `bundle.mjs`.

## Conventions

- **Code style:** match the surrounding code — TypeScript, ESM, existing naming and comment density. Moderate doc comments on functions and complex logic.
- **Don't touch unrelated code.** No drive-by refactors or "improvements."
- **Tests:** run `npm test` and `npm run typecheck` after changes. Add tests only when the logic warrants it (the integration suite builds a real DuckDB index from synthetic fixtures in a temp dir — never touches real `~/.claude`).
- **Commits:** Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). Do not add AI co-author or "Generated with" trailers — keep history clean and human-authored.
- **Linear history:** rebase onto `main`; no merge commits. PRs land via fast-forward, rebase, or squash.
- **Plans:** when doing non-trivial work, save the plan directly into the repo as `docs/plans/NNNN-kebab-title.md` (next sequential number) from `docs/plans/TEMPLATE.md`, set its `Status`, add a row to the index table, and link it in the PR. If you planned via plan mode, the plan was written to ephemeral storage outside the repo — check there and copy it in, otherwise it's lost. See `docs/plans/README.md`.

## Gotchas

- **Thinking blocks render empty** — the system stores only a signature, not the reasoning text. Expected, not a bug.
- **Cost is a local estimate** from token usage × `pricing.json` rates; not real billing. Computed once at index time and stored.
- **Release is maintainer-only** and tag-triggered (npm Trusted Publishing / OIDC). See `CONTRIBUTING.md`.

See `CONTRIBUTING.md` for the full workflow and `README.md` for user-facing docs.
