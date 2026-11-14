# 0098 — Screenshots for Live, agent tree, Extensions, and Files changed

- **Status:** done
- **Date:** 2026-11-14
- **PR:** <link, once opened>

## Context

`npm run screenshots` captured six views from synthetic data. A product site
needs four more (Live, the agent tree, Extensions, Files changed). While adding
them, the pipeline turned out to leak: Antigravity and Grok were never pointed at
the temp tree, so a run on a developer machine read the real
`~/.gemini/antigravity-cli` and showed its sessions, paths, and sources.

## Goal

Four new light and dark views, captured from fabricated data only, with every
agent source and home-relative lookup confined to the temp tree and a guard that
fails the run if the real home path reaches a page or API response.

## Decisions

- **Isolate by environment, not by filtering output.** All eight sources, the
  opencode config dir, `HOME`, and `XDG_*` point into the temp dir, so nothing
  can resolve to the real home. `HOME` is the temp root, which also makes the
  UI render sources as `~/claude/projects`. The DuckDB extension cache is the one
  real path kept, because re-downloading ~31 MB per run is not worth it and it
  is never rendered.
- **Live state is seeded relative to now, twice.** The Live tab reads file
  mtime and transcript tails, so sessions are written relative to the seed time
  (`demo-seed-live.mjs`). A run can take minutes, which would age a Working card
  into Possibly stuck, so the pipeline re-seeds those sessions and restarts the
  indexer right before the `live` and `agents` shots. Each live session has a
  fixed file path, so a re-seed overwrites instead of adding a second session.
- **Everything else is aged.** Every other seeded file gets an old mtime, so
  only the five live sessions fall inside the activity window.
- **The agent tree is the Live focus page** (`/live/live-agents`), seeded as an
  idle Claude Code session with a nested subagent, a background subagent,
  `SendMessage`, a task notification, and a hand-back row.

## Approach

1. Fix isolation, seed Antigravity and Grok, fix the opencode seed schema, add
   the leak guard.
2. Seed the live sessions, a multi-file session, skill and subagent usage, and
   the Claude and Codex extension homes.
3. Add the four views to `scripts/screenshots.mjs` and regenerate.

## Files affected

- `scripts/screenshots.mjs`, `scripts/demo-seed.mjs`: isolation, views, guard.
- `scripts/demo-seed-live.mjs`: new, the now-relative sessions.
- `docs/screenshots/*.png`: regenerated, plus eight new images.

## Testing

`npm run build && npm run screenshots` (the run fails on a leak), then a visual
check of every PNG. `npm run typecheck`, `npm test`.

## Risks / open questions

- The seeded live sessions are dated today, so Analytics gains one recent day
  and Browse shows acme-web as active now.
- Skill and plugin paths show the temp dir's realpath (truncated) in the
  Extensions location column; it is not the real home.
