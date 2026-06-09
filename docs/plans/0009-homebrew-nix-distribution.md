# 0009 — Homebrew + Nix distribution

- **Status:** in-progress <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-09
- **PR:** <link, once opened>

## Context

Claudescope ships only as the npm package `@vladar107/claudescope` (`npm i -g` /
`npx`). Users reach for their platform's default package manager — Homebrew on
macOS, Nix for a reproducible cross-platform path. We want both, without a second
build pipeline. The one native dependency, `@duckdb/node-api`, ships its
per-platform prebuilt binaries as npm `optionalDependencies` (macOS x64/arm64,
Linux x64/arm64), so wrapping the npm package lets npm/Nix resolve the right
binary automatically.

## Goal

`brew install vladar107/tap/claudescope` and `nix run github:vladar107/claudescope`
both work; each release auto-syncs the Homebrew formula; and `claudescope update`
tells brew/nix users the correct upgrade command instead of corrupting the install
with `npm install -g`.

## Decisions

- **Wrap the npm package, not self-contained binaries** — lowest effort, reuses
  the tag-triggered npm release, native binary auto-resolved. Rejected SEA/`pkg`
  binaries (heavier CI matrix, fiddly native-file packaging) — revisit only if a
  no-Node install (e.g. WinGet) is wanted later.
- **Channels: Homebrew + Nix only** — Scoop/WinGet/AUR deferred.
- **Homebrew tap repo named `homebrew-tap`** → `vladar107/tap/claudescope`.
  Rejected `homebrew-claudescope` (forces the awkward doubled
  `vladar107/claudescope/claudescope`).
- **`flake.nix` at the repo root** — required: a subdir flake's `self` can't reach
  the parent monorepo for `buildNpmPackage { src = self; }`. Footprint is the two
  standard flake files only; all logic stays inline (no `nix/` dir, no scripts).
- **`update` detects & defers** — classify install method from the bundle's
  realpath (`/nix/store/`, Homebrew Cellar) and print the manager's upgrade command.
- **Sync automated in `release.yml` as independent jobs** — validate → create
  release → npm ∥ nix, then brew after npm (it consumes the published npm tarball).
  Independent jobs so one channel's failure doesn't block the rest. Rejected a
  single linear job / a pre-publish Nix gate (a broken flake would block npm).

## Approach

1. **`packages/server/src/cli.ts`** — add `detectInstallMethod()` (realpath →
   `brew` | `nix` | `npm`) and branch `update()` to defer for brew/nix.
2. **`flake.nix`** (+ `flake.lock`) at root — `buildNpmPackage`, `src = self`,
   `npmBuildScript = "bundle"`, custom `installPhase` that installs `dist/` and
   vendors `node_modules/@duckdb` beside `cli.js`, `autoPatchelfHook` +
   `stdenv.cc.cc.lib` on Linux for the prebuilt `.node`, `makeWrapper` over
   `nodejs_22`. Exposes `packages.default`, `apps.default`, `checks.default`.
3. **`Formula/claudescope.rb`** in the separate `vladar107/homebrew-tap` repo —
   `depends_on "node"` + `system "npm", "install", *std_npm_args`.
4. **`.github/workflows/release.yml`** — independent jobs: `validate` (tag-match +
   tests) → `release` (create GitHub Release) → `npm` (bundle + publish) ∥ `nix`
   (`nix build .#claudescope` verify), then `brew` after `npm` (rewrites the
   formula with the published tarball + sha256 and pushes to the tap repo via
   `HOMEBREW_TAP_TOKEN`). A failure in one channel doesn't block the others.
   **`ci.yml`** — a `nix` job builds the flake on PRs.
5. **Docs** — README install methods, CONTRIBUTING (tap, token, `npmDepsHash`
   refresh), CLAUDE.md distribution note.

## Files affected

- `packages/server/src/cli.ts` — install-method detection + `update()` branch.
- `flake.nix`, `flake.lock` (new) — Nix package/app/check.
- `Formula/claudescope.rb` (new, **separate `homebrew-tap` repo**) — npm wrapper.
- `.github/workflows/release.yml`, `.github/workflows/ci.yml` — gate + tap sync.
- `README.md`, `CONTRIBUTING.md`, `CLAUDE.md` — install + maintainer docs.

## Testing

- `npm run typecheck` + `npm test` (cli.ts change stays type-clean). ✅
- Nix (machine with Nix): `nix build .#` → `./result/bin/claudescope version`;
  `nix run .#` boots :4317. Run on macOS (arm64) + Linux (x64) for the
  autoPatchelf / DuckDB-binding load path. **Bootstrap step:** first build with
  `npmDepsHash = lib.fakeHash` prints the real hash to paste into `flake.nix`.
- Homebrew (local): `brew install --build-from-source ./Formula/claudescope.rb` →
  `claudescope version`, `brew test`. Then a real release pushes to the tap.
- `update` deferral: install via brew/nix and confirm it prints the manager's
  command and does not run npm.

## Risks / open questions

- **Nix `@duckdb/node-bindings-*` optional dep** — fetching the right host-platform
  binding through `buildNpmPackage` + loading the `.node` after autoPatchelf is the
  known friction point; validate on both OSes early.
- **`npmDepsHash` is `lib.fakeHash` until bootstrapped** — the `nix` job (PRs and
  release) fails until a maintainer fills the real hash. Because release channels
  are independent jobs, this only breaks the Nix channel — npm and Homebrew still
  publish. Bootstrap before relying on the Nix channel.
- **`HOMEBREW_TAP_TOKEN`** secret + the `vladar107/homebrew-tap` repo must exist
  before the tap-sync step succeeds.
