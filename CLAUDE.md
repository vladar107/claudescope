# Claudescope — agent guide

A local, **read-only**, **multi-agent** viewer to browse, read, search, and
analyze AI coding-agent transcripts in one place — [Claude Code](https://claude.com/claude-code) (`~/.claude/projects/**/*.jsonl`),
[OpenAI Codex](https://openai.com/codex)
(`~/.codex/sessions/**/rollout-*.jsonl`), and
[JetBrains Junie](https://www.jetbrains.com/junie/)
(`~/.junie/sessions/session-*/events.jsonl`). Sessions are merged by working
directory into one project per `cwd`, each session tagged with its agent.
Distributed as a single npm CLI (`@vladar107/claudescope`). This file is the
source of truth for both humans and agents working in this repo; `AGENTS.md`
points here.

## Architecture

npm-workspaces monorepo (`packages/*`):

| Package           | Role                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `packages/shared` | TypeScript types — the API + data contract shared by server and web.   |
| `packages/server` | Fastify API + DuckDB index (`@duckdb/node-api`); serves the built UI.  |
| `packages/web`    | Vite + React UI (react-markdown, Shiki, Recharts).                     |

- The server serves **both** the API and the built SPA on **one port** (`4317`).
- DuckDB reads the JSONL natively (`read_ndjson`) for indexing, full-text search,
  and analytics. A TS parser assembles the threaded view for a single session.
- **Agent connectors** (`packages/server/src/connectors/`) abstract each source.
  Claude Code projects per-row; Codex spreads a session across record types, so
  its connector normalizes a rollout to canonical NDJSON first (`codex/normalize.ts`).
  Adding an agent = adding a connector; the index/FTS/cost paths stay shared.
- The DuckDB index is a **derived cache** — fully rebuildable from the JSONL. If
  it's corrupt the app discards and rebuilds it.

## Runtime state — critical

- **NEVER write to `~/.claude` or `~/.codex`.** They are read-only data sources.
- All app-owned state lives in **`~/.claudescope/`** (override: `CLAUDESCOPE_HOME`):
  the DuckDB index, a user-editable `pricing.json` (seeded from a shipped
  default; `loadPricing` falls back to the default if the copy is missing), the
  daemon PID file, and logs. State lives outside the package dir so global
  installs survive upgrades — do not move it back into the package.

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

## Distribution model

`npm run bundle` (`scripts/bundle.mjs`) produces the published artifact in
`dist/`: esbuild bundles the server + CLI (shared lib inlined) into two minified,
source-map-free files; the web build, a default `pricing.json`, and `README.md`
are copied alongside; a self-contained `package.json` is generated whose only
runtime dependency is the native `@duckdb/node-api`. The **version is injected at
bundle time** via esbuild `define` (`__CLAUDESCOPE_VERSION__`) — never hardcode
it. Publish metadata (keywords, repo, etc.) is sourced from the **root**
`package.json`; edit it there, not in `bundle.mjs`.

**Other channels wrap this npm package** — no separate artifacts. **Homebrew**
(formula in the separate `vladar107/homebrew-tap` repo) and a **Nix flake**
(`flake.nix` at the repo root, builds from source via `buildNpmPackage`) both
install `@vladar107/claudescope` under the hood and let npm/Nix resolve the native
`@duckdb/node-api` binary. `release.yml` runs as independent jobs (validate →
create release → npm ∥ nix, then brew after npm): it bumps the Homebrew formula
(needs the `HOMEBREW_TAP_TOKEN` secret) and verifies the flake builds. A failure
in one channel doesn't block the others. The flake's `npmDepsHash` only changes
when deps change, not per version.
The CLI `update` command (`cli.ts`) detects the install method and defers to
`brew`/`nix` instead of `npm install -g` for those installs. See `CONTRIBUTING.md`.

## Conventions

- **Code style:** match the surrounding code — TypeScript, ESM, existing naming
  and comment density. Moderate doc comments on functions/complex logic.
- **Don't touch unrelated code.** No drive-by refactors or "improvements."
- **Tests:** run `npm test` and `npm run typecheck` after changes. Add tests only
  when the logic warrants it (the integration suite builds a real DuckDB index
  from synthetic fixtures in a temp dir — never touches real `~/.claude`).
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). **Do not add AI
  co-author / "Generated with" trailers** — keep history clean and human-authored.
- **Linear history:** rebase onto `main`; no merge commits. PRs land via
  fast-forward / rebase / squash.
- **Plans:** when an agent does non-trivial work, **save the plan directly into
  the repo** as `docs/plans/NNNN-kebab-title.md` (next sequential number) from
  [`TEMPLATE.md`](./docs/plans/TEMPLATE.md), set its `Status`, add a row to the
  index table, and link it in the PR. If you planned via `/plan` (plan mode), the
  plan was written to **ephemeral** storage outside the repo (e.g.
  `~/.claude/plans/<name>.md`) — check there and copy it in, otherwise it's lost.
  See `docs/plans/README.md`.

## Gotchas

- **Thinking blocks render empty** — Claude Code stores only a signature (and
  Codex only encrypted reasoning), not the plaintext. Expected, not a bug.
- **Codex sessions have no stored title** — the session title falls back to the
  first user message (see `first_user` in `data/index.ts`).
- **Junie transcripts read differently** — Junie stores an event-sourced UI
  stream (`events.jsonl`), not a chat log: no assistant prose and no thinking, so
  a session renders as tool/terminal/file blocks plus a final result. Expected,
  not a bug. Older Junie sessions also lack a recorded `cwd` (no `projectDir` in
  `index.jsonl`) and group under the `(unknown — Junie)` project bucket.
- **Cost is a local estimate** from token usage × `pricing.json` rates; not real
  billing. Computed once at index time and stored.
- **Release is maintainer-only** and tag-triggered (npm Trusted Publishing /
  OIDC). See `CONTRIBUTING.md`.

See `CONTRIBUTING.md` for the full workflow and `README.md` for user-facing docs.
