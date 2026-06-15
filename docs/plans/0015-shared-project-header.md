# 0015 — Shared project header (nested layout route)

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-15
- **PR:** https://github.com/vladar107/claudescope/pull/18

## Context

After 0014 added a per-project Memory tab, navigating **Sessions ↔ Memory**
within a project swapped the *entire* header: the Sessions view showed the
project name + cwd + sort/filter controls, while the Memory view showed a
"Project memory" title and a different crumb. The two sub-views rendered as
separate pages, so switching tabs read as a full page reload rather than
swapping a panel — visual noise the user flagged.

## Goal

A **stable shared header** across a project's sub-views: the breadcrumb, project
name, cwd, and the Sessions | Memory tab bar stay put; only the body below the
tabs changes when switching tabs.

## Decisions

- **Nested layout route, not a shared component** — `/projects/:projectId` is a
  layout route (`ProjectLayout`) that renders the header once + `<Outlet>`, with
  child routes `index` (sessions) and `memory`. The header *instance persists*
  across tab switches (no remount), and the project-meta fetch happens once in
  the layout instead of in each tab — so the transition is seamless and avoids a
  redundant `listProjects` call. Rejected: a `<ProjectHeader>` component rendered
  by each page (headers would look identical but each page still remounts and
  refetches — cosmetic only).
- **Tabs via `NavLink`** — active state derives from the route (`end` on the
  Sessions/index link), replacing the manual `is-active` toggle.
- **Sub-view-specific controls move into the body** — the sort/filter controls
  (Sessions-only) render below the tab bar in the Sessions tab, so they
  appear/disappear without shifting the shared header.
- **Tab bodies read shared meta via Outlet context** — `useProjectContext()`
  exposes `{ projectId, project }`; the Memory body keeps using `useParams` for
  the id (it doesn't need project meta).

## Approach

1. `pages/browse/ProjectLayout.tsx` (new): fetch project meta once; render
   crumb + name + cwd + Sessions|Memory `NavLink` tabs + `<Outlet context={{ projectId, project }}>`.
   Export `useProjectContext()`.
2. `pages/browse/SessionList.tsx`: drop the crumb/header/tab bar; read
   `{ projectId, project }` from context; render the controls + agent filter +
   list as the tab body.
3. `pages/memory/ProjectMemoryPage.tsx`: drop the crumb/title/tab bar; render the
   per-agent memory as the tab body.
4. `App.tsx`: nest the project routes under `ProjectLayout` (`index` → sessions,
   `memory` → memory).

## Files affected

- `packages/web/src/pages/browse/ProjectLayout.tsx` (new) — shared chrome.
- `packages/web/src/pages/browse/SessionList.tsx` — Sessions tab body.
- `packages/web/src/pages/memory/ProjectMemoryPage.tsx` — Memory tab body.
- `packages/web/src/App.tsx` — nested routes.

## Testing

- `npm run typecheck` + `npm test` (no server/contract changes).
- Manual: open a project, toggle Sessions ↔ Memory — the header/tabs stay put,
  only the body swaps; deep-links and back/forward still work.

## Risks / open questions

- The agent-first Memory pages (`/memory/:connectorId[/:projectId]`) are a
  separate hierarchy and intentionally keep their own breadcrumbs.
- Per-project **Codex** memory attribution (so Codex memory appears under a
  project like Claude) remains a separate follow-up — Codex memory is a single
  global handbook, not per-project files.
