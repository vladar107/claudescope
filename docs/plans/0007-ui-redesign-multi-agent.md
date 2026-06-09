# 0007 — UI redesign: multi-agent viewer, light/dark, responsive nav

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-09
- **PR:** <link, once opened>

## Context

Claudescope grew a Codex connector and the first multi-agent UX, but the UI
lagged: dark-only with no theme switch, dead-end navigation (Browse → Project →
Sessions was component-state, not URLs, so a session view could only link back to
Browse), no per-agent visibility, a fixed non-responsive layout, and docs still
positioning it as Claude-Code-only with dark-only screenshots. Two latent Codex
bugs also surfaced during the work: sessions had no title (all "Untitled"), and
pasted images rendered as raw `<image …>` placeholder text.

## Goal

A polished multi-agent viewer: system-aware light/dark themes with a manual
toggle, URL-driven project navigation with a back-to-sessions breadcrumb, visible
per-agent split (filter + correct totals), a responsive desktop layout, refreshed
multi-agent docs, and automated light+dark screenshots.

## Decisions

- **Theme = system default + persisted manual toggle** — dark palette stays the
  `:root` base; `:root[data-theme='light']` overrides only colors. A pre-paint
  script in `index.html` resolves the choice before first paint (no flash);
  `ThemeProvider` keeps React in sync and feeds `resolvedTheme` to Shiki/Recharts.
- **Project card stays "two tags + combined sum"** — an early per-agent-breakdown
  card was rejected by the user as too busy; the combined total already includes
  every agent (verified: per-agent sums equal the project total). The per-agent
  split lives where it aids navigation: a filter on the project's session list.
- **No Codex aggregation "fix"** — investigation showed Codex tokens/cost were
  already correctly counted (the apparent gap was K-vs-M rounding). Dropped the
  planned pricing/token-attribution fixes as no-ops.
- **Codex titles + images are real fidelity gaps, fixed in scope** — title falls
  back to the first user message; `input_image` items map to image blocks the
  frontend already renders.
- **Screenshots automated with Playwright** (new dev dependency) — reproducible
  light+dark capture beats manual shots.
- **AGENTS.md → thin pointer to CLAUDE.md** — single source of truth, no drift.

## Approach

1. **Navigation** — add `/projects/:projectId` route; `BrowsePage` is the grid
   (cards are `<Link>`s); `SessionList` becomes the routed `SessionListPage`;
   session view breadcrumb links back to the project's sessions.
2. **Per-agent** — `ProjectMeta.agents[]` breakdown in the projects route;
   `&agent=` filter on `/api/sessions`; agent filter chips on the session list.
3. **Theming** — palette split + light overrides; `ThemeProvider`/`useTheme`;
   both Shiki themes; `getChartColors(theme)`; segmented toggle in the nav footer.
4. **Responsive** — narrower nav + padding on small laptops; icon-rail collapse
   under 720px; wrapping toolbars.
5. **Codex fidelity** — first-user-message title fallback; `input_image` → image
   block; strip the `<image …>` placeholder (also drops the local temp path).
6. **Docs + screenshots** — README repositioned as a multi-agent viewer with
   `<picture>` theme-switching shots; Codex demo data (`acme-web` is multi-agent);
   Playwright `scripts/screenshots.mjs` (`npm run screenshots`); CLAUDE.md updated.

## Files affected

- `packages/web/src/App.tsx`, `pages/browse/{BrowsePage,SessionList}.tsx`,
  `pages/session/SessionPage.tsx` — routing + breadcrumb + agent filter.
- `packages/web/src/theme/ThemeProvider.tsx`, `main.tsx`, `index.html`,
  `styles/global.css`, `browse.css`, `session.css`, `search.css` — theming +
  responsive + `<mark>`/finder tokens.
- `packages/web/src/components/{highlighter,CodeBlock,LineDiff}.tsx`,
  `pages/analytics/{chart-common,TimeSeriesChart,BreakdownChart}.tsx` — themed
  Shiki + Recharts.
- `packages/shared/src/{api,events}.ts` — `agents[]`, `projectDisplayName`,
  `agent` query, `ImageBlock`.
- `packages/server/src/routes/{projects,sessions}.ts`, `data/index.ts`,
  `connectors/codex/normalize.ts` — per-agent SQL, agent filter, title fallback,
  Codex image blocks.
- `scripts/{demo-seed,screenshots}.mjs`, `package.json`, `README.md`, `CLAUDE.md`,
  `AGENTS.md`, `docs/screenshots/*-{light,dark}.png`.

## Testing

- `npm run typecheck` and `npm test` (76+ tests) green; Codex integration test
  extended to assert the title fallback and the rendered image block (placeholder
  path stripped).
- `npm run build` clean; `npm run screenshots` regenerates all 8 PNGs.
- Manual: toggle System/Light/Dark (body, code, charts, badges, search marks all
  switch; no flash; choice persists); session → project back link; resize
  1440→1024→~900px; multi-agent card shows both tags; agent filter on the
  session list.

## Risks / open questions

- Both Shiki themes are bundled (negligible size bump over the existing grammar
  chunks).
- Playwright stays a dev dependency, excluded from `npm run bundle`; the capture
  script needs `npx playwright install chromium` once.
