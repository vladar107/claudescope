# 0028 — CI/CD segmentation & reusable workflows

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-21
- **PR:** https://github.com/vladar107/claudescope/pull/39

## Context

The three GitHub Actions workflows (`ci.yml`, `perf.yml`, `release.yml`) are flat
and unsegmented, which produces two concrete problems:

1. **Tag publish double-runs the world.** Releasing is `npm version patch && git
   push --follow-tags`, which pushes the **bump commit to `main`** *and* the **tag**
   in one push. The bump commit (a trivial version-number change to root
   `package.json` + `package-lock.json`) triggers the full `ci.yml` matrix — **4
   test legs + 2 nix legs ≈ 6 redundant jobs** — while the tag triggers
   `release.yml`, which *re-validates, re-builds, and re-nixes* the same commit.
   Per release, tests run ~5×, nix ~3×. (Tag pushes themselves do **not** trigger
   `ci.yml` — its `branches:` filter excludes tags — so only the bump *branch*
   push is redundant.)
2. **No change-area segmentation.** A docs-only or frontend-only change runs the
   entire matrix + nix (and perf on PRs). The perf bench is 100% server/data-layer
   yet runs on every PR.

The repeated `checkout + setup-node + npm ci` block and the `nix build` job are
also duplicated across workflows with no shared definition.

## Goal

Make *what runs* a function of *what changed*; stop the release bump commit from
re-running CI; and share the build/test + nix logic between CI and Release via
reusable workflows — without weakening the release safety gate.

## Decisions

- **Full reuse via reusable workflows** — composite `setup` action + reusable
  `build-test.yml` & `nix-build.yml` called by **both** `ci.yml` and `release.yml`.
  Rejected the lighter "composite action only" option because the maintainer wants
  CI and Release to share one definition of build/test and nix. (A one-time
  branch-protection settings change is required either way, because path-gating
  produces "skipped" legs.)
- **Keep post-merge CI on `main`, skip release bumps** — a `guard` job detects a
  `v*` tag on the pushed HEAD and skips CI's code jobs, since `release.yml` already
  validates that exact commit. Rejected dropping post-merge CI entirely (loses the
  safety net for direct pushes / merge skew) and rejected path-ignoring
  `package.json` (real dep/script changes touch it too).
- **Docs-only changes get a light docs check** — lychee link check + markdownlint
  with a config seeded from current docs (starts green), and skip
  build/test/nix/perf.
- **Coarse `code` gating for build/test** — typecheck (`tsc -b`) and the
  `shared → web → server` build are genuinely monolithic, so there is no safe
  per-package build/test skip. The real saving is docs-only skipping build-test
  entirely. Perf is gated separately (server/shared only); nix is gated on `infra`.

## Approach

### New files

1. **`.github/actions/setup/action.yml`** — composite: `setup-node` (+ `cache: npm`)
   then `npm ci`. Inputs `node-version` (required), `registry-url` (default `''`),
   `cache-dependency-path` (default `''`), `working-directory` (default `.`).
   Checkout stays in the caller (perf needs dual checkout). `shell: bash` on the
   `run` step (works on Windows runners).
2. **`.github/workflows/build-test.yml`** — reusable (`workflow_call`, inputs `os`,
   `node` as strings): checkout → composite setup → `npm run typecheck` →
   `npm run build` → `npm test`. Declares `permissions: contents: read`.
3. **`.github/workflows/nix-build.yml`** — reusable (`workflow_call`, input `os`):
   checkout → `DeterminateSystems/nix-installer-action@main` →
   `nix build .#claudescope -L`. `permissions: contents: read`.
4. **`.lycheeignore`** — external/auth-gated URLs to skip in the link check.
5. **`.markdownlint-cli2.jsonc`** — lenient rules seeded by running markdownlint once
   against current docs and disabling every rule the existing docs violate (so it
   starts green and only catches new regressions).

### `ci.yml` (push to `main` + PR)

Job graph:

```
changes  (dorny/paths-filter → code, perf, docs, infra)    fetch-depth: 0
guard    (is_release: HEAD carries a v* tag?)               fetch-depth: 0
   ├─ build-test  uses: ./.github/workflows/build-test.yml  matrix os{ubuntu,windows}×node{22,24}
   │                if: guard.is_release != 'true' && changes.code == 'true'
   ├─ nix         uses: ./.github/workflows/nix-build.yml   matrix os{ubuntu,macos-14}
   │                if: guard.is_release != 'true' && changes.infra == 'true'
   ├─ docs-lint   if: guard.is_release != 'true' && changes.docs == 'true'   (markdownlint + lychee)
   └─ ci-success  if: always()  needs: [changes, guard, build-test, nix, docs-lint]  ← ONLY required check
```

- **`changes`** (`dorny/paths-filter@v3`): outputs `code` / `perf` / `docs` /
  `infra`. `infra` (root `package.json`, `package-lock.json`, `tsconfig*.json`,
  `vitest.config.ts`, `flake.{nix,lock}`, `scripts/**`, `.github/workflows/**`,
  `.github/actions/**`) is folded into `code` so config/dep/CI changes always run
  the full build/test. **`perf` does NOT use the broad `infra` set** — the bench is
  `tsx packages/server/perf/run.ts` and is unaffected by web tsconfig, the flake,
  the bundle script, or unrelated workflow files. `perf` is its own surgical list:
  `packages/server/**` ∪ `packages/shared/**` ∪ root `package.json` ∪
  `package-lock.json` ∪ `.github/workflows/perf.yml` ∪ `.github/actions/**`. **No
  `packages/web/**` path triggers perf** — frontend source changes never run the
  bench. The only frontend-adjacent path that can still trigger perf is the
  workspace-wide `package-lock.json` (a web-only dep bump touches it, and paths
  alone can't distinguish a web dep from a server/shared runtime dep); triggering
  perf there is the conservative default (a transitive backend-runtime dep change
  *could* move the bench). `docs` = `**/*.md` ∪ `docs/**` ∪ `LICENSE`.
  On `push` events set `base: ${{ github.ref }}` + checkout `fetch-depth: 0`; PRs
  use the API. Add `permissions: pull-requests: read`.
- **`guard`**: on non-push → `is_release=false`. On push → `git fetch --tags
  --force` then `git tag --points-at HEAD | grep -qE '^v[0-9]'` →
  `is_release=true`. `fetch-depth: 0` defeats the `--follow-tags` visibility race.
- **Reusable callers**: matrix + `uses:` is legal; `if:` is allowed on `uses` jobs.
  `os`/`node` pass via `with:` (they're inputs because a `uses:` job can't carry
  `steps`/`runs-on`).
- **`docs-lint`**: `DavidAnson/markdownlint-cli2-action@v20` (globs `**/*.md`) +
  `lycheeverse/lychee-action@v2` (`--cache --no-progress "**/*.md"`).
- **`ci-success`** shim: `always()`, inspects `needs.*.result`; **skipped = pass,
  failure/cancelled = fail**. The single required status check.

### `perf.yml` (PR-only)

Add a `changes` job gating the `perf` job on the `perf` filter, and a `Perf
success` shim (`always()`, skipped = pass) so it's safe whether or not perf is a
required check. PR-head install switches to `uses: ./pr/.github/actions/setup` with
`working-directory: pr` + `cache-dependency-path: pr/package-lock.json`. **Keep the
base side's bare `npm ci`** — base must run main's harness, not PR-introduced
tooling (existing invariant; do not refactor).

### `release.yml` (reuse only; no behavior change)

- Split `validate` → `verify-tag` (inline: checkout → composite setup → tag==
  version check) + `validate` (`uses: ./.github/workflows/build-test.yml`,
  `os: ubuntu-latest`, `node: '24'`, `needs: verify-tag`). This *strengthens*
  release validation: it now typecheck+build+tests (today it only `npm test`s).
- `nix` channel → `uses: ./.github/workflows/nix-build.yml` (`os: ubuntu-latest`,
  `needs: release`).
- **Leave `npm` and `brew` inline** — they need `id-token: write` (OIDC) and
  `secrets.HOMEBREW_TAP_TOKEN`; routing those through reusables adds `secrets:`
  ceremony for no reuse benefit. Optionally fold the npm job's setup into the
  composite with `registry-url: https://registry.npmjs.org`.

### Manual step (must accompany the merge)

Moving `test`/`nix` under reusable workflows renames their reported check names, so
the old required checks (`test (ubuntu-latest, 22)` …, `nix (…)`) would never
report and **wedge every PR**. In **Settings → Branches → `main` protection**, in
the same change window: **require `CI success`** (and `Perf success` if perf should
block), and **remove** the six obsolete `test (…)` / `nix (…)` checks. Inspect
current required checks first with `gh api
repos/vladar107/claudescope/branches/main/protection`.

## Files affected

- `.github/actions/setup/action.yml` — **new** composite action.
- `.github/workflows/build-test.yml` — **new** reusable workflow.
- `.github/workflows/nix-build.yml` — **new** reusable workflow.
- `.lycheeignore`, `.markdownlint-cli2.jsonc` — **new** docs-lint config.
- `.github/workflows/ci.yml` — add `changes` + `guard` + `docs-lint` +
  `ci-success`; replace inline `test`/`nix` with reusable callers.
- `.github/workflows/perf.yml` — add `changes` guard + `perf-success` shim;
  PR-head uses the composite.
- `.github/workflows/release.yml` — `validate`/`nix` call the reusables.
- `docs/plans/README.md` — index row for this plan.

## Testing

1. **Lint the YAML**: run `actionlint` over `.github/workflows/*.yml` (catches the
   matrix+`uses:` shape, `if:` expressions, output references). No app code
   changes, so `npm run typecheck` / `npm test` are unaffected.
2. **Dedup guard, locally**: on a release tag commit `git tag --points-at HEAD`
   lists `vX.Y.Z`; on a normal commit it's empty.
3. **On a feature branch pushed to GitHub** (local `uses: ./…` only resolves
   server-side):
   - docs-only PR → only `changes`/`guard`/`docs-lint`/`ci-success` run;
     `build-test`/`nix` skipped; `CI success` green.
   - frontend-only PR (`packages/web/**`) → `build-test` runs, `nix` + perf
     skipped.
   - backend PR (`packages/server/**`) → `build-test` + perf run.
   - lockfile/flake PR → `build-test` + `nix` + perf all run.
4. **Release dry-run**: cut a throwaway prerelease tag on a branch and confirm the
   bump-commit push to main shows `build-test`/`nix` *skipped* (`is_release=true`)
   while `release.yml` runs validate → release → npm ∥ nix → brew.

## Risks / open questions

- **Required-check name drift** (highest): mitigated by the `CI success` shim + the
  branch-protection edit done atomically with the merge.
- **paths-filter push base**: `base: github.ref` + `fetch-depth: 0` on push; PRs
  use the API. Without it, push events fail-open to a full run (safe, not lean).
- **`--follow-tags` tag visibility race**: `fetch-depth: 0` + `git fetch --tags
  --force`. Worst case the guard misses → redundant (not dangerous) CI run.
- **markdownlint noise / lychee external flakiness**: seed `.markdownlint-cli2.jsonc`
  from current docs; `--cache` + `.lycheeignore` for lychee; can be made advisory
  if noisy.
- **perf base contamination**: keep base side's bare `npm ci`; pass only flags
  main's `run.ts` understands (existing in-file note).
- **Tuning knob**: `nix` is gated on `infra` (deps/flake/build-tooling). Switch to
  `code` for belt-and-suspenders at the cost of 2 nix legs on every source PR.
