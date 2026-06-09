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
  the logic warrants it; don't add tests for trivial changes.
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

The release workflow verifies the tag matches `package.json`, runs the tests,
runs `npm run bundle`, publishes `dist/`, and creates a GitHub Release from the
tag's curated message. We follow [SemVer](https://semver.org). Do not re-tag an
already-published version (the publish step will fail).
