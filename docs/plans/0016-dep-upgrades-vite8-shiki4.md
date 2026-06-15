# 0016 — Dependency upgrades: esbuild/vite 8/vitest 4/shiki 4 (clear Dependabot)

- **Status:** done
- **Date:** 2026-06-15
- **PR:** <link, once opened>

## Context

GitHub Dependabot flagged 3 open alerts, all the same dev dependency — **esbuild**
(< 0.28.1): two for [GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr)
(high — Deno binary-integrity RCE) on `package.json` + the lockfile, and one for
[GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) (low —
esbuild dev-server file read on Windows). Neither exploit path applies to this
local, single-user, npm-installed tool, and esbuild is build-only (never
shipped). Real-world risk ≈ nil, but the alerts are worth clearing for hygiene.

esbuild entered the tree three ways: our direct devDep (`^0.25.0`, used by
`scripts/bundle.mjs`), transitively via **vite 6** (`esbuild ^0.25.0`), and via
**tsx** (`esbuild ~0.28.0`, locked at 0.28.0). Bumping our direct dep + tsx's
nested copy clears two alerts; the vite-transitive copy needed vite itself to
move. We chose to upgrade vite rather than pin via `overrides`, and folded in the
shiki major bump (1 → 4) the same PR since it's all dev-toolchain modernization.

## Goal

`npm audit` reports 0 vulnerabilities and all 3 Dependabot alerts close, with the
web build, test suite, and publishable bundle all green — done as one combined
`chore(deps)` PR.

## Decisions

- **Upgrade vite 6 → 8 instead of an `esbuild` override** — an override would
  force vite 6 off its declared `esbuild ^0.25.0` range (unsupported combo) and
  rot into a stale pin that holds esbuild back later. Vite 8 pulls a patched
  esbuild (0.28.1) on its own, so the fix comes from the ecosystem, not a manual
  cap. Vite 7 was a non-starter (`esbuild ^0.27.0`, still < 0.28.1).
- **vitest 3 → 4 and @vitejs/plugin-react 4 → 6 are mandatory companions** —
  plugin-react's peer is `vite ^8`; vitest 3 bundles vite 6. vitest 4 peers
  `vite ^6 ‖ ^7 ‖ ^8`, so after the bump a single `npm update vite` deduped the
  whole tree onto vite 8 (vitest had kept a stale nested vite 6.4.3 → esbuild
  0.25.12, the last vulnerable copy).
- **shiki 1 → 4 needs no code change** — the app was already on the modern
  `createHighlighter` API (the v3 `getHighlighter` rename); `codeToHtml`,
  `codeToTokens`, `bundledLanguages`, `loadLanguage`, and the oniguruma engine
  default all survive v4. Verified by a runtime smoke test, not just typecheck.
- **Tighten `engines.node` `>=22` → `>=22.12`** to match vite 8's
  `^20.19.0 || >=22.12.0` requirement honestly.
- **tsx not version-bumped** — already at latest (4.22.4); only its nested
  esbuild needed lifting, which its existing `~0.28.0` range already permitted.

## Approach

1. Bump root `esbuild` `^0.25.0 → ^0.28.1`, `vitest` `^3.0.5 → ^4.1.9`, and
   `engines.node` `>=22 → >=22.12`.
2. Bump `packages/web`: `vite ^6.0.5 → ^8.0.16`, `@vitejs/plugin-react
   ^4.3.4 → ^6.0.2`, `shiki ^1.5.3 → ^4.2.0`.
3. `npm install`, then `npm update vite esbuild` to dedupe the tree onto a single
   vite 8 / esbuild 0.28.1.
4. Verify: typecheck, test, build, bundle, shiki runtime smoke, `npm audit`.

## Files affected

- `package.json` — esbuild, vitest, engines.node bumps.
- `packages/web/package.json` — vite, plugin-react, shiki bumps.
- `package-lock.json` — regenerated; vite 8/rolldown dropped ~56 transitive
  packages (no more standalone rollup/esbuild duplication).

## Testing

- `npm run typecheck` — clean (shiki 4 / vite 8 / vitest 4 types satisfy
  existing usage; no source edits).
- `npm test` — 137/137 pass on vitest 4.
- `npm run build` — passes on vite 8 / Rolldown; shiki grammars still
  code-split per language; oniguruma wasm chunk present.
- `npm run bundle` — `server.js` + `cli.js` assembled on esbuild 0.28.1.
- Shiki runtime smoke (throwaway, exercising the real `highlighter.ts`):
  preloaded + on-demand grammars, `codeToHtml`, `codeToTokens`, and the
  plaintext fallback all behave.
- `npm audit` — **0 vulnerabilities**; single deduped `esbuild@0.28.1` and
  `vite@8.0.16` across the tree.

## Risks / open questions

- Rolldown is vite 8's bundler — production output differs from vite 6's
  rollup/esbuild path. Build + bundle are green; a manual browser pass of the
  built SPA (highlighting, charts, markdown, dev proxy) is the remaining
  belt-and-suspenders check.
- The >500 kB chunk warning is advisory and pre-existing (shiki grammars are
  large); not introduced by this change.
