# 0060 — Dependabot alerts #13–#19

- **Status:** in-progress <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-29
- **PR:** <link, once opened>

## Context

Seven open Dependabot alerts (5 high, 2 moderate) on `main`, which are really
**four distinct packages** — the `@fastify/static` findings are reported twice
each, once against `packages/server/package.json` and once against
`package-lock.json`.

| alert(s) | package | sev | CVSS | fixed in | scope |
| --- | --- | --- | --- | --- | --- |
| #14, #18 | `@fastify/static` | high | 7.5 | 10.1.1 | runtime, **direct** |
| #15, #19 | `@fastify/static` | medium | 5.3 | 10.1.2 | runtime, **direct** |
| #17 | `brace-expansion` | high | 7.5 | 5.0.8 | runtime, transitive |
| #13 | `postcss` | high | 7.5 | 8.5.18 | **development** only |
| #16 | `react-router` | high | 0 | 8.3.0 | runtime, transitive via `react-router-dom` |

Only one of these is a genuinely exposed runtime surface: `@fastify/static` is
what serves the built SPA, and the high-severity advisory is a **route-guard
bypass via path traversal** in exactly that component.

## Goal

`npm audit` clean and all seven alerts closed, with the two runtime-visible major
bumps verified end to end rather than only by unit tests.

## Decisions

- **`@fastify/static` 9.1.3 → ^10.1.2 (major)** — no patch exists on the 9.x
  line; 10.1.2 is the first release clearing both advisories. v10 depends on
  `fastify-plugin@^6`, which targets Fastify 5, so it matches the pinned
  `fastify@^5.2.0`.
- **`brace-expansion` and `postcss` need no `overrides`** — both were already
  satisfiable inside their parents' declared ranges (`minimatch` asks for
  `^5.0.5`; `vite` asks for `^8.5.15`), so the lockfile was simply stale. A
  targeted `npm update` moved them to 5.0.8 / 8.5.25. Deliberately not adding
  root `overrides` for these, unlike alerts #7–#10 in
  [0050](./0050-dependabot-alerts-7-10.md) — an override that merely restates
  what the parent range already permits is dead weight that hides future drift.
- **`postcss` is dev-only and not shipped** — it is Vite's, used at build time.
  Fixed because it is free, but it is not a risk to anyone running the published
  package.
- **`react-router`: migrate off `react-router-dom` rather than dismiss** — the
  advisory itself (**RSC Mode CSRF Bypass**, CVSS **0**) is *not reachable* here:
  the app is a plain `<BrowserRouter>` SPA with no `createBrowserRouter`, no
  loaders or actions, and no `@react-router/*` framework packages, so RSC mode
  does not exist in it. Dismissing as not-applicable was therefore defensible.

  It was fixed anyway because of what the alert exposed: **`react-router-dom` is a
  dead end.** Its latest release is `7.18.2` and it pins `react-router` to exactly
  `7.18.2`, so there is no 8.x of the shim and never will be — staying on it means
  never receiving another router fix, applicable or not. The whole surface used is
  nine stable exports (`BrowserRouter`, `NavLink`, `Outlet`, `Route`, `Routes`,
  `useLocation`, `useOutletContext`, `useParams`, `useSearchParams`), all present
  in `react-router@8.3.0`, so this is an import swap across 13 files. `react` and
  `react-dom` were already at `19.2.7`, which is exactly v8's peer floor
  (`>=19.2.7`), so no React bump was needed.
- **Verify in a real browser, not just via the suite** — both majors land on things
  unit tests do not touch: `@fastify/static` serves the SPA and backs the
  deep-link `sendFile('index.html')` fallback, and the router owns every
  navigation. A green suite would not have caught either breaking.
- **Take the Nix `npmDepsHash` from CI** — the real dependency set changed, so the
  `fetchNpmDeps` fixed-output hash changes with it. Nix is unavailable on this
  machine; the CI `nix` job prints the expected value (same procedure as 0050).

## Approach

1. `npm install -w @claudescope/server @fastify/static@^10.1.2`.
2. `npm update brace-expansion postcss` to refresh the stale transitive pins.
3. Rewrite 13 `from 'react-router-dom'` imports to `from 'react-router'`, drop
   `react-router-dom`, add `react-router@^8.3.0`.
4. Verify: typecheck, suite ×3, build, `npm run bundle`, `npm audit`.
5. Verify end to end against sandboxed fixtures — static assets, SPA fallback,
   traversal refusal, every route, deep-link reload, back/forward.
6. Refresh `flake.nix`'s `npmDepsHash` from the CI `nix` job.

## Files affected

- `packages/server/package.json` — `@fastify/static@^10.1.2`.
- `packages/web/package.json` — `react-router-dom` out, `react-router` in.
- `packages/web/src/**/*.tsx` — 13 import rewrites.
- `package-lock.json` — the above plus refreshed `brace-expansion` / `postcss`.
- `flake.nix` — `npmDepsHash`.

## Testing

- `npm test` 591/62 unchanged, run 3×; typecheck, build, `npm run bundle`, and
  `npm audit` (**0 vulnerabilities**, with and without `--omit=dev`).
- End-to-end against a sandboxed fixture corpus on port 4390:
  - `@fastify/static` v10: root document and hashed asset serve with correct
    content types; all seven deep links return `index.html`; `/api/*` 404s stay
    JSON; four path-traversal shapes (raw, encoded, mixed, via `/assets/`) leak
    nothing.
  - Router v8: client-side navigation across Browse/Search/Analytics/Memory/
    Settings with an in-page marker proving no full reload; project → session
    detail renders the prompt text and the tool block; `useParams` resolves the
    session id; back/forward; deep-link reload; and a cold deep link in a fresh
    tab. **Zero console/page errors.**

## Risks / open questions

- `@fastify/static` v10 is a major bump. The API this repo uses is two calls
  (`register(fastifyStatic, {root})` and `reply.sendFile`), both verified above,
  but other v10 behaviour changes are untested because unused.
- `react-router@8` is a major bump whose migration guide may cover APIs this app
  does not use. Only the nine imported exports were checked.
- The `react-router` alert may still show as open if GitHub matches on
  `react-router-dom`'s pinned transitive `react-router` — it should close, since
  that package is gone from the tree entirely.
