# 0051 — Settings page: indexer lifecycle + settings.json layer

- **Status:** done
- **Date:** 2026-07-22
- **PR:** https://github.com/vladar107/claudescope/pull/69

## Context

Claudescope had no user-facing settings surface: every knob was an env var
frozen at boot in `config.ts`, and the only UI preference (theme) hid in the
sidebar. A Settings-page mockup was challenged against the architecture and
reduced to what fits it:

- **Lifecycle controls target the INDEXER, not the process.** The HTTP server
  is never stopped from the UI (terminal-only). The reindex poller + DuckDB
  ingest are the real resource consumers and were already separable machinery —
  Start/Stop/Restart become real, meaningful buttons with no dead-page paradox.
- Dropped from the mockup: backup path (no backup feature exists), user
  accounts/"Admin Mode", a process START button (the UI is served by the
  process it would start), a "READ/WRITE" paths badge (sources are READ-ONLY —
  the product promise), "vector store" naming (it's the DuckDB index), and an
  auto-restart-on-crash toggle (no supervisor exists).

## Goal

A `/settings` page where users can: pause/resume/restart background indexing,
edit agent source dirs + reindex interval + open-browser-on-start (persisted
to `~/.claudescope/settings.json`, applied live where possible), sync pricing,
see version/update/uptime, switch theme, and rebuild the index behind a
confirm — with per-field provenance (env / saved / default) and env-shadow
warnings.

## Decisions

- **Persistence: `settings.json` under `CLAUDESCOPE_HOME`, env always wins**
  (env > file > default, resolved per call). Rejected: file-over-env (breaks
  scripted overrides and the test harness); UI-read-only (defers the feature).
- **Config consts → runtime getters** (`settings.ts`), connectors resolve
  their dir once per discovery pass and expose `sourceDir` via object-literal
  getters — so dir changes apply with a reindex kick, not a process restart.
  The deleted consts made `tsc -b` enumerate every consumer.
- **Indexer lifecycle, not process lifecycle** (`indexer-lifecycle.ts`): pause
  disarms the poller (index stays queryable; in-flight passes drain), the
  pause flag is runtime-only. `requestPass()` drains an in-flight pass then
  runs one more, making "save dir → sessions appear" deterministic.
- **Rebuild runs through the same `inFlight` slot as `reindex()`** so poller
  ticks coalesce instead of racing the closed DuckDB connection; it also
  re-prices history (cost is stamped at index time).
- **Update stays terminal-driven**: `GET /api/system` shows the install-method
  command (npm/brew/nix via the extracted `install-method.ts`); the server
  never shells out to package managers.
- **CSRF mutation guard** (`registerMutationGuard`): the Host guard doesn't
  stop same-Host cross-origin no-cors POSTs; now that the API writes files,
  mutations require `Sec-Fetch-Site` same-origin/none (when present) and JSON
  content types.
- **`openBrowser` setting has no env layer** — `OPEN_BROWSER` is the internal
  launcher contract (the daemon pins it to `0`), so treating it as a user
  override would misreport in the UI; the CLI folds flag > settings > default.

## Approach

1. Shared API types (`packages/shared/src/api.ts`): settings/lifecycle section.
2. `settings.ts` (registry, mtime-cached loader, atomic saves, validation,
   getters) + const→getter migration across all 8 connectors, `index.ts`,
   `cli.ts`.
3. `indexer-lifecycle.ts` (poller extraction, pause/resume/restart,
   `requestPass`) + `rebuildIndex()`/`discardDbFiles()`; `/api/health` gains
   compact indexer state.
4. Routes: `GET/PUT /api/settings`, `POST /api/indexer/{stop,start,restart}`,
   `POST /api/index/rebuild` (202/409), `POST /api/pricing/refresh`,
   `GET /api/system`; `registerMutationGuard` in `security.ts`.
5. CLI: `start` consults the persisted `openBrowser` (flag wins).
6. Web: `pages/settings/` (SettingsPage, SettingRow, settings.css),
   `ConfirmDialog` + `tv-btn--danger` (first modal/danger primitives),
   client methods, StatusProvider passes `indexer` through, theme toggle moves
   from the sidebar into Appearance.
7. Tests (bug-prone edges): settings precedence/corruption/atomicity,
   PUT→live-apply→reindex pickup, lifecycle pause/coalescing, rebuild
   snapshot/re-pricing/409, mutation-guard matrix.

## Files affected

- `packages/shared/src/api.ts` — new settings/lifecycle contract types.
- `packages/server/src/settings.ts` (new), `config.ts` — settings layer;
  editable consts removed.
- `packages/server/src/connectors/*` — getter migration (all 8 connectors).
- `packages/server/src/indexer-lifecycle.ts` (new), `data/index.ts`,
  `db/duckdb.ts`, `index.ts` — poller extraction + rebuild.
- `packages/server/src/routes/{settings,indexer,pricing,system}.ts` (new),
  `routes/index.ts`, `security.ts`, `install-method.ts` (new), `cli.ts`,
  `update-check.ts`.
- `packages/web/src/pages/settings/*` (new), `App.tsx`, `api/client.ts`,
  `status/StatusProvider.tsx`, `components/ConfirmDialog.tsx` (new),
  `styles/global.css`.

## Testing

`npm test` + `npm run typecheck` green at every step. New suites:
`settings.test.ts`, `settings-api.integration.test.ts`,
`indexer-lifecycle.integration.test.ts`, `index-rebuild.integration.test.ts`,
mutation-guard cases in `security.test.ts`. Manual: run the app, change a
source dir on /settings, watch sessions appear; pause/resume; rebuild.

## Risks / open questions

- The const→getter sweep could silently change a default — mitigated by
  copying defaults verbatim into `SETTING_DEFS` and the full integration suite.
- Rebuild closes the DuckDB connection; a concurrent query 500s once and
  recovers on the next request — acceptable for an explicit danger action.
- PORT shows source `env` for daemon-started servers (the CLI always injects
  it) — honest but slightly noisy.
- Pause is runtime-only: a self-restart or crash resumes indexing (stated in
  the UI).
