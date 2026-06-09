# 0006 — Multi-agent UX (badges, sources footer, analytics-by-agent, cache toggle)

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-09
- **PR:** `feat/codex-connector` (same PR as 0005, per user request)

## Context

With two agents indexed (0005), the UI couldn't distinguish them and analytics
couldn't break down by agent. User feedback: (1) agent tag on sessions +
projects; (2) the sidebar footer hardcoded `~/.claude/projects` and ignored
Codex; (3) analytics should show spend + tokens per agent and in total;
(4) the cache series cluttered every chart. (Codex "Files changed" deferred —
Codex edits ride through `exec_command` shell, not structured tool calls.)

## Decisions / approach

- **Foundation:** propagate `connector_id` from `files` → `sessions` (new column,
  `SCHEMA_VERSION` 3→4, discard/rebuild) via a `session_connector` CTE in
  `rebuildSessions`. Surface as `SessionMeta.connectorId` and
  `ProjectMeta.connectorIds` (a cwd can host multiple agents — many-to-many).
- **Agent badge:** `AgentBadge` component + `.tv-chip--agent` with brand-ish hues
  (Claude coral, Codex teal). Rendered on session rows, project cards, and the
  session-detail header. `agentLabel()` maps `claude-code`→"Claude",
  `codex`→"Codex".
- **Sources footer:** `AgentConnector` gains `label` + `sourceDir`; new
  `GET /api/sources` lists connectors whose dir exists (home → `~`); the sidebar
  footer renders `Read-only · <paths>`.
- **Analytics by-agent:** `AnalyticsGroupBy` += `'agent'`; analytics `groupSource`
  adds an `agent` case (`s.connector_id`). Existing sums/totals give per-agent
  spend + tokens and the totals row = "in total". UI adds an "By agent" segment.
- **Cache toggle:** a default-off "Show cache" checkbox; charts drop the cache
  bar and the summary hides the cache card unless on. Cache still counted in
  totals.

## Files

- shared: `src/api.ts` (SessionMeta.connectorId, ProjectMeta.connectorIds,
  AnalyticsGroupBy 'agent', SourceInfo/SourcesResponse).
- server: `db/schema.ts` (sessions.connector_id, v4), `data/index.ts`
  (session_connector CTE), `routes/{sessions,projects,analytics}.ts`, new
  `routes/sources.ts` + registration, `connectors/{types,claude-code,codex/codex}.ts`
  (label/sourceDir).
- web: `api/client.ts` (sources), `App.tsx` (footer), new
  `components/AgentBadge.tsx`, `pages/browse/{BrowsePage,SessionList}.tsx`,
  `pages/session/SessionPage.tsx`, `pages/analytics/{AnalyticsPage,BreakdownChart,
  TimeSeriesChart,format}.tsx`, CSS (`browse.css`, `analytics.css`).

## Testing / outcomes

- `npm run typecheck` ✓; `npm test` ✓ — 76 tests. `codex.integration.test.ts`
  asserts `connectorId === 'codex'`, `groupBy=agent` returns a codex row, project
  `connectorIds` includes codex, and `/api/sources` lists the codex dir;
  `api.integration.test.ts` asserts `connectorId === 'claude-code'`.
- `npm run build` ✓. Bench headline metrics unchanged (Claude path; one extra
  cheap CTE) — PR `perf.yml` A/B enforces ≤20%.

## Risks / follow-ups

- `SCHEMA_VERSION` 3→4 rebuilds the index once on upgrade (expected).
- Codex "Files changed" still deferred.
- Product positioning / rename (two agents now) remains a separate decision.
