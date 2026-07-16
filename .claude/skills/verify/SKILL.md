---
name: verify
description: Build, launch, and drive Claudescope against sandboxed fixtures to verify a change end-to-end without touching real agent sources or ~/.claudescope.
---

# Verifying Claudescope changes

## Sandboxed launch (never touch real agent homes or ~/.claudescope)

Every data source and state dir is env-overridable (`packages/server/src/config.ts`).
Build, then run the server against a scratch dir:

```bash
npm run build    # shared → web → server; server serves the built SPA

SB=$(mktemp -d)  # sandbox: fixtures + app state
mkdir -p $SB/home $SB/projects/-tmp-demo $SB/empty
# Claude Code fixture format: see writeFixtures() in packages/server/test/api.integration.test.ts

cd packages/server
CLAUDESCOPE_HOME=$SB/home CLAUDE_PROJECTS_DIR=$SB/projects \
CODEX_SESSIONS_DIR=$SB/empty JUNIE_SESSIONS_DIR=$SB/empty PI_SESSIONS_DIR=$SB/empty \
OPENCODE_DATA_DIR=$SB/empty COPILOT_SESSIONS_DIR=$SB/empty \
ANTIGRAVITY_CLI_DIR=$SB/empty ANTIGRAVITY_DIR=$SB/empty \
PORT=4390 REINDEX_INTERVAL_MS=3000 node dist/index.js &
```

- Use a non-default port (**not** 4317 — the user's real daemon may hold it).
- `REINDEX_INTERVAL_MS=3000` makes auto-reindex fast enough to observe.
- API surface: `curl http://127.0.0.1:4390/api/...` (health, sessions, search).
- **Kill the server when done** (kill the PID you started).

## Driving the UI

Playwright is already a dev dependency (perf suite). From a script anywhere:

```js
import { chromium } from '<repo>/node_modules/playwright/index.mjs';
```

Gotchas learned the hard way:

- Playwright fires `framenavigated` for SPA pushState too — to prove "no page
  reload", set `window.__marker = 1` after load and check it survived.
- Steady-state list updates arrive within reindex interval + 10s idle health
  poll; wait up to ~30s for new rows.
- Dropping a new `<cwd-slug>/sessN.jsonl` fixture while the app runs is the
  way to simulate a live agent session landing.

## Flows worth driving

- Browse → project card → session list → session page (the core read path).
- Drop a new session fixture mid-run: list + project header stats should
  update without reload (dataVersion refetch).
- Kill + restart the server with the page open: it must recover via the
  unreachable poll and keep updating (dataVersion resets on restart).
