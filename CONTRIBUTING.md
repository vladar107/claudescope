# Contributing to Claudescope

Thanks for contributing! This guide covers how to set up, make changes, and get
them merged. For architecture and conventions, see [`CLAUDE.md`](./CLAUDE.md)
(the source of truth, shared by humans and agents).

## Prerequisites

- [Node.js](https://nodejs.org) **20 or newer** (`node -v`).

## Setup & dev loop

```bash
npm install         # install workspace deps
npm run dev         # server (watch) on :4317 + Vite dev server on :5317 (HMR)
```

In dev, open the **Vite** URL (http://localhost:5317); it proxies `/api` to the
server. Useful commands:

```bash
npm run build       # production build (shared → web → server)
npm test            # Vitest (run once)   |  npm run test:watch
npm run typecheck   # tsc -b across all packages
npm run bundle      # assemble the publishable single package into dist/
```

## Project layout

npm-workspaces monorepo: `packages/shared` (types), `packages/server` (Fastify +
DuckDB), `packages/web` (Vite + React). See `CLAUDE.md` for details. Key rule:
the app is **read-only** over `~/.claude`; its own state lives in `~/.claudescope/`.

## Making changes

- **Match the existing code** — TypeScript, ESM, surrounding naming and comment
  density. Don't refactor or "improve" code unrelated to your change.
- **Run `npm test` and `npm run typecheck`** before opening a PR. Add tests when
  the logic warrants it; don't add tests for trivial changes. **Keep tests
  focused on the weird stuff** — malformed/truncated JSONL, subagent correlation,
  cost dedup-by-`message.id`, stale-cache / index-corruption recovery, pricing
  refresh and fallback, connector quirks — not happy-path glue that can't fail.
- **Validate at boundaries** (user input, external data); trust internal code.

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
`npm` because its formula points at the published npm tarball. Because the channels
are independent jobs, a failure in one (e.g. a stale Nix hash) does **not** block
the others — just re-run that job. We follow [SemVer](https://semver.org). Do not
re-tag an already-published version (the publish step will fail).

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
