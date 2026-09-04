# Contributing to Claudescope

Thanks for contributing! This guide covers how to set up, make changes, and get
them merged. For architecture and conventions, see [`CLAUDE.md`](./CLAUDE.md)
(the source of truth, shared by humans and agents).

## Prerequisites

- [Node.js](https://nodejs.org) **22.13 or newer** (`node -v`) — matches the
  `engines` field in `package.json`.

## Setup & dev loop

```bash
npm install         # install workspace deps
npm run dev         # server (watch) on :4317 + Vite dev server on :5317 (HMR)
```

In dev, open the **Vite** URL (http://localhost:5317); it proxies `/api` to the
server. Useful commands:

```bash
npm run build       # production build (shared → web → server)
npm run serve       # run the already-built server without rebuilding
npm test            # Vitest (run once)   |  npm run test:watch
npm run typecheck   # tsc -b across all packages
npm run bundle      # assemble the publishable single package into dist/
npm run screenshots # regenerate the README screenshots from synthetic demo data
```

`npm run screenshots` seeds the synthetic demo data, boots the app, and captures
every view in both light and dark themes via Playwright — run it when a UI change
makes the README screenshots stale.

## How it works

npm-workspaces monorepo:

| Package           | Role                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `packages/shared` | TypeScript types — the API + data contract shared by server and web. |
| `packages/server` | Fastify API + DuckDB index (`@duckdb/node-api`); serves the built UI. |
| `packages/web`    | Vite + React UI (react-markdown, Shiki, Recharts).                   |

DuckDB reads the JSONL natively (`read_ndjson`) for indexing, full-text search,
and analytics; a small TypeScript parser assembles the threaded view for a single
session. The index is a **derived cache** — if it's ever corrupted (e.g. the
process is killed mid-write) the app discards and rebuilds it automatically.

Each agent is a **connector** (`packages/server/src/connectors/`). Claude Code
JSONL is projected per-row; the others (Codex spreads a session across record
types, Junie and GitHub Copilot CLI record an event-sourced stream, pi keeps
`cwd`/tool-results on separate records, opencode is a single SQLite database) run a `prepare()` pass
that normalizes a session to canonical NDJSON first — after that the indexing,
search, cost, and threading paths are all shared. Adding another agent is adding
another connector (see [Adding an agent connector](#adding-an-agent-connector)).

Tests use [Vitest](https://vitest.dev). Unit tests cover the thread/subagent
parser and pure helpers; the **integration suite** builds a real DuckDB index
from synthetic fixtures in a temp dir / temp DB — your real agent directories are
never touched — and exercises every API endpoint end-to-end via Fastify
`inject()`.

**Key rule:** the app is **read-only** over every agent source (`~/.claude`,
`~/.codex`, `~/.junie`, `~/.pi`, opencode's database); its own state lives in
`~/.claudescope/`. See [`CLAUDE.md`](./CLAUDE.md) for the full architecture and
[`docs/architecture.md`](./docs/architecture.md) for C4 architecture diagrams.

## Making changes

- **Match the existing code** — TypeScript, ESM, surrounding naming and comment
  density. Don't refactor or "improve" code unrelated to your change.
- **Run `npm test` and `npm run typecheck`** before opening a PR. Add tests when
  the logic warrants it; don't add tests for trivial changes. **Keep tests
  focused on the weird stuff** — malformed/truncated JSONL, subagent correlation,
  cost dedup-by-`message.id`, stale-cache / index-corruption recovery, pricing
  refresh and fallback, connector quirks — not happy-path glue that can't fail.
- **Validate at boundaries** (user input, external data); trust internal code.

## Adding an agent connector

Supporting another coding agent means adding one **connector** — the index, FTS,
cost, threading, and UI paths are all shared, so you only implement the seam.
Use an existing connector as a template (`connectors/opencode/` is the most
complete: SQLite source, `prepare()` normalization, file-edit and image mapping).
Work through this checklist — the starred items are the ones that are easy to
forget and silently render nothing in the UI.

1. **Implement the `AgentConnector` port** in
   `packages/server/src/connectors/<agent>/` (interface in
   [`connectors/types.ts`](./packages/server/src/connectors/types.ts)): `id`,
   `label`, `sourceDir`, `discover()`, `eventsProjectionSql()`, `loadSession()`,
   and `auxProjections()` (titles / PR links). If the raw format can't be
   projected per-row by DuckDB (multiple record types, a separate `cwd`/result
   record, a SQLite DB), add a `prepare()` pass that normalizes a session to
   **canonical NDJSON** first (the Codex / pi / opencode pattern). The projection
   must emit the `CANONICAL_EVENT_COLUMNS` contract.

2. **Register it** in
   [`connectors/registry.ts`](./packages/server/src/connectors/registry.ts) (the
   `connectors` array).

3. **Resolve its source dir from an env var** in
   [`config.ts`](./packages/server/src/config.ts) (e.g. `FOO_SESSIONS_DIR`,
   defaulting under `homedir()`, run through `expandHome`), and set the
   connector's `sourceDir` from it. The startup banner / sidebar
   (`routes/sources.ts`) then lists it automatically.

4. **★ Map tools to canonical names so the reader and tabs work.** The UI keys
   off canonical tool names, so normalize the agent's tools (see
   `connectors/opencode/normalize.ts`):
   - **File edits/writes → `Write` / `Edit` / `MultiEdit`.** This is what feeds
     the **Files changed** tab and the per-file red/green diffs. An agent that
     edits via some other mechanism (opencode's `apply_patch`, a custom tool)
     **must** be translated, or the tab silently shows nothing.
   - **`read` → `Read`, shell → `Bash`**, so those blocks get the right preview;
     pass other tools through by name.
   - **★ Pasted screenshots / images → `ImageBlock`** (`{ type: 'image', source:
     { type: 'url' | 'base64', … } }`, see
     [`shared/src/events.ts`](./packages/shared/src/events.ts)), or images won't
     embed in the transcript.

5. **★ Add the agent badge** — without it the agent shows a raw id with no color:
   - A short label in `AGENT_LABELS` in
     [`components/AgentBadge.tsx`](./packages/web/src/components/AgentBadge.tsx).
   - Brand-color CSS in
     [`pages/browse/browse.css`](./packages/web/src/pages/browse/browse.css)
     (`.tv-chip--agent.tv-agent--<id>`). **Use the agent's official/corporate
     brand hue** (matching the existing ones: Anthropic coral, OpenAI teal-green,
     JetBrains green, …). Follow the established pattern — border at `<hex>66`,
     background at `<hex>1a`, a legible accent for the text — and add the
     `:root[data-theme='light']` override that darkens the text for the light
     theme.

6. **Memory (optional).** If the agent persists long-lived memory, implement
   `globalMemory()` and/or `projectMemory()`. **Invariant: read only from the
   agent's own home dir** — never from the user's project directories. Return
   `[]` when there's none (the empty state is first-class).

7. **Tests.** Add synthetic fixtures in a temp dir / DB (never touch real agent
   dirs) and **focus on the weird stuff** — the normalization quirks, malformed /
   truncated input, cost dedup, threading edges — not happy-path glue.

8. **★ Update every doc that enumerates the agents — keep them in sync:**
   - [`README.md`](./README.md): the **Supported agents** table, the
     **Configuration** env-var table, the **Usage notes** (any format quirk worth
     calling out), and the **privacy + Security & privacy** source lists.
   - [`SECURITY.md`](./SECURITY.md): the **Filesystem → Reads** list of read-only
     source dirs.
   - [`CLAUDE.md`](./CLAUDE.md): the architecture/connector notes and the
     **Gotchas** + read-only-source list.
   - The **How it works** list of normalized formats above, if `prepare()` is
     involved.

## Commits & history

- Use [Conventional Commits](https://www.conventionalcommits.org):
  `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- **Do not add AI co-author or "Generated with" trailers.** Keep history clean
  and human-authored.
- **Keep history linear.** Rebase your branch onto `main` (`git rebase main`) —
  do **not** create merge commits. PRs land via fast-forward, rebase, or squash;
  never a merge bubble. Resolve conflicts by rebasing, not merging `main` back in.

## Working with agents

Using an AI agent is welcome. One rule:

- **If an agent did non-trivial work, commit its plan** under `docs/plans/`
  (`NNNN-title.md`, start from `TEMPLATE.md`) and **link it in the PR**. This
  keeps the reasoning and decisions in the repo. See
  [`docs/plans/README.md`](./docs/plans/README.md). Trivial one-line fixes don't
  need a plan.

## Pull requests

- Open a PR against `main`; fill in the template (it loads automatically).
- Make sure CI is green (typecheck, build, tests).
- Keep PRs focused — one logical change per PR.

## Releasing (maintainers only)

Releases are **maintainer-only** and **tag-triggered** — never published from a
laptop. Publishing uses npm **Trusted Publishing (OIDC)**; there is no
`NPM_TOKEN` secret, and provenance is attached automatically.

**Release notes are human-curated.** Write a short, highlight-first changelog and
embed it in the version commit + annotated tag via `npm version -m` (the first
line stays `%s` so the version leads). The workflow mirrors that tag message to a
**GitHub Release** verbatim (`--notes-from-tag`) — notes are never auto-generated.

```bash
# 1. Draft the highlights (most-important first), then bump + tag with them:
npm version minor -m "%s

- <headline change>
- <another notable change>"
# (patch / minor / major per SemVer — bumps package.json, commits, annotates the tag)

# 2. Push the bump commit AND the tag:
git push --follow-tags   # the tag triggers .github/workflows/release.yml
```

The release workflow runs as independent jobs: a **`validate`** gate (tag matches
`package.json` + tests) → **create the GitHub Release** → then the channels. `npm`
(bundle + publish) and `nix` (flake build) run in parallel; **`brew`** runs after
`npm` because its formula points at the published npm tarball. The registry takes
5–15 min to serve a freshly published tarball, so `brew` polls for it (up to
~30 min); a release therefore takes 10–30 min end to end and needs no re-run.
Because the channels are independent jobs, a failure in one (e.g. a stale Nix
hash) does **not** block the others — just re-run that job. We follow
[SemVer](https://semver.org). Do not re-tag an already-published version (the
publish step will fail).

### Distribution channels

Homebrew and Nix both **wrap the published npm package** — no separate build
artifacts. They're kept in sync automatically:

- **Homebrew** — the release job rewrites `Formula/claudescope.rb` in the separate
  [`vladar107/homebrew-tap`](https://github.com/vladar107/homebrew-tap) repo,
  pointing it at the new npm tarball + sha256. This cross-repo push needs a
  fine-grained PAT with `contents: write` on that repo, stored as the
  **`HOMEBREW_TAP_TOKEN`** secret (`github.token` cannot push to another repo).
- **Nix** — `flake.nix` lives at the repo root and builds from source, so Nix pins
  by git commit (no URL to bump). Its dependency hash is **version-independent**:
  the flake feeds `fetch-npm-deps` a copy of `package-lock.json` with the project
  version neutralized (`depsLock`), so a version bump never changes the hash.
  **Releasing needs no Nix and no hash step** — just `npm version` + push. The hash
  only changes when dependencies *actually* change (add/remove/upgrade a package),
  which the CI `nix` job catches on the PR; to update it then, set the hash to
  `lib.fakeHash`, run `nix build .#claudescope`, and paste the `got:` value back.
  A genuine build break only fails the `nix` job — since channels are independent,
  npm and Homebrew still publish.
