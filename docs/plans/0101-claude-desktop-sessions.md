# 0101 — Claude Code desktop sessions: worktree projects, custom titles, surface

- **Status:** done
- **Date:** 2026-11-26
- **PR:** https://github.com/vladar107/claudescope/pull/143

## Context

The Claude desktop app's Code tab writes standard Claude Code transcripts to
`~/.claude/projects/<slug>/<id>.jsonl` (verified on bundled Claude Code
2.1.330), with `entrypoint: "claude-desktop"` on message rows. So desktop
sessions are already indexed under the Claude Code connector. Three gaps:

1. **Worktree sessions split into their own projects.** `sessions.project_cwd`
   is the modal cwd over *all* event rows. Six real sessions land in
   one-session projects named `<repo>/.claude/worktrees/<name>`: in all six the
   main thread ran at the repo root, but `isolation: "worktree"` subagent rows
   outvoted it. The desktop app starts every session in
   `<repo>/.claude/worktrees/<name>` by default (CLI `--worktree` uses the same
   location), so each desktop session would become its own project.
2. **Renamed titles are ignored.** The titles projection reads `ai-title` only.
   Desktop titles and CLI `/rename` are `custom-title` rows (20 in the local
   corpus), so those sessions show the first-message fallback.
3. **No way to tell where a session ran.** `entrypoint` (`cli`,
   `claude-desktop`, `claude-vscode`, `sdk-*`) isn't indexed.

Cowork (desktop "local agent mode") and cloud sessions are out of scope: no
local transcripts.

## Goal

Desktop and CLI worktree sessions group under their repo's project and resume
from the right directory; renamed sessions show their name; sessions carry a
"started from" surface with a filter in the API, CLI, MCP, and web list.

## Decisions

- **Worktree fold is an agent-neutral path rule in the data layer** (advisor
  consult) — projects merge across agents by cwd, so any agent's session inside
  a Claude worktree belongs to the repo; a per-connector hook applied globally
  would be the same rule with extra contract. Revisit if an agent keeps
  worktrees outside the repo, where suffix-stripping can't recover the repo.
- **Fold before the vote; keep voting over all rows.** `project_cwd` = modal of
  the folded cwd. Measured on a copy of the real index: exactly the 6 split
  sessions move to their repo, 0 sessions of any other agent move. A
  main-thread-only vote (advisor's and critique's suggestion) was measured and
  rejected: it also moved a root session into a subdirectory project.
- **Resume uses the starting directory** — new raw `sessions.cwd` = cwd of the
  earliest main-thread row with a non-null cwd (fallback: earliest row with
  one). A session with no cwd at all (Junie/Antigravity unknown buckets) keeps
  today's behaviour: no resume command. Claude Code files a
  transcript under the slug of the directory it started in. Measured: the
  current rule (modal `project_cwd`) points 12 Claude Code resume commands at
  the wrong directory; the starting directory matches the transcript's folder
  in all 12. No other agent's resume directory changes.
- **Surface is a file-keyed aux table, one "started from" value per session**
  (advisor consult) — file-keyed like `compactions`; an `events` column was
  rejected (widens the canonical contract across 8 connectors for one agent's
  fact). Only main-thread rows are stored. The value is the entrypoint of the
  earliest non-fork main-thread row that carries one, so a session never moves
  between filter buckets and counts stay disjoint.
- **Surface is a declared capability** — `SURFACE_SIGNAL` in
  `agent-capabilities.ts`; agents without one report the field absent, never
  `cli`. Raw values stored; labels live in the web layer. The web filter is
  labelled "Started from"; picking a value shows only Claude Code sessions.
- **The latest `custom-title` row wins over `ai-title`**; if that row is empty
  (a cleared name) the `ai-title` applies. No empty rows exist locally, so this
  is the defensive reading. A fork inherits its parent's name when the copied
  rows carry one (as for `ai-title` today); no special handling.
- C1, C2 and C3 ship in one PR behind one `SCHEMA_VERSION` bump (28), which
  rebuilds the index so titles and surfaces are re-projected.

## Approach

Waves (tier from Jev `plan-tier` unless noted). Each chunk writes its own new
test file; no shared fixture helpers are edited.

### Wave 1 (parallel)

**C1 — Worktree projects and resume directory** (complex, Jev 1.0 → Opus)

- `data/project-id.ts`: one exported fold pattern + `projectCwdFromCwd(cwd)`
  (leftmost `[/\\]\.claude[/\\]worktrees[/\\][^/\\]+` and everything after;
  a fold that would yield `''` returns the input).
- `db/schema.ts`: `sessions.cwd VARCHAR`; `SCHEMA_VERSION` 28, one comment line
  covering C1–C3.
- `data/index.ts` `rebuildSessions`: `modal_cwd` votes on the folded cwd (keep
  the deterministic tie-break); new `start_cwd` CTE for `sessions.cwd` (earliest
  non-null main-thread cwd by `(ts, uuid)`, then earliest non-null of any row).
- `routes/sessions.ts`: resume built from `sessions.cwd`.
- `agent/shape.ts` `projectIdForCwd`: fold before hashing.
- Call-site audit (no change expected, confirm): the projects route, analytics
  project filter, search, digest and memory attribution all read
  `sessions.project_cwd`; `resolve` matches the nearest project above a cwd;
  the live snapshot doesn't read cwds.
- CLAUDE.md gotcha: fold before vote, starting directory for resume.

Test file `test/worktree-projects.integration.test.ts`. Acceptance:
- a parity table run through both the TS helper and DuckDB `regexp_replace`
  (POSIX and Windows separators, nested worktrees, subdir inside a worktree,
  bare `.claude/worktrees`, a look-alike such as `.claude/worktrees-old`);
- (a) a root session whose subagent rows outnumber it in a worktree → repo
  project, resume at root; (b) a session started inside a worktree → repo
  project, resume in the worktree; (c) a session that starts at the root and
  spends most rows in a worktree → resume at root;
- `sessions --cwd <worktree>` and `resolve` from inside a worktree both reach
  the repo project.

**C2 — custom-title precedence** (simple, Jev 0.72 → Sonnet)

- `connectors/claude-code/claude-code.ts` titles projection: read `customTitle`;
  the latest `custom-title` row wins when non-empty, else the latest `ai-title`.

Test file `test/custom-title.integration.test.ts`. Acceptance: ai-title then
custom-title → custom; custom-title then a later ai-title → still custom; a
rename followed by an empty custom-title → the ai-title.

### Wave 2

**C3a — Surface indexing and capability** (complex, Jev 0.85 → Opus; after C1
and C2: shares `schema.ts`, `index.ts`, `claude-code.ts`)

- `db/schema.ts`: file-keyed `surfaces (file_path, session_id, surface,
  first_ts)`; `sessions.surface VARCHAR`.
- `connectors/types.ts` `AuxProjections.surfaces?`; `data/index.ts`: stage →
  delete-by-file → insert in `loadFile`, and delete-by-file in the
  removed-file sweep (both places `compactions` is handled; a connector whose
  `discover()` threw keeps its rows through the existing skip);
  `rebuildSessions` derives `surface` (earliest `first_ts`, NULLs last,
  tie-break on value).
- Claude Code projection: main-thread rows with non-null `entrypoint`, no
  `forkedFrom`, grouped per (session, entrypoint).
- `data/agent-capabilities.ts` `SURFACE_SIGNAL` + registry conformance test
  `test/connector-surface-signal.test.ts` (pattern:
  `connector-skill-signal.test.ts`).
- `shared`: `SessionMeta.surface?`, `ProjectMeta.surfaces?` (same shape as
  `agents`). `rowToSessionMeta` sets `surface` only for declared connectors.

Test file `test/surface.integration.test.ts`. Acceptance: a desktop session →
`claude-desktop`; a desktop fork of a CLI session → `claude-desktop`; reloading
a subagent file leaves the parent's surface intact; deleting a session's file
removes its surface rows; a session with no `entrypoint` has no `surface`.

### Wave 3 (parallel)

**C3b — Surface filter in API, CLI, MCP** (Sonnet: mechanical, copies the
`branch` filter through every layer; my call, not Jev's)

- `routes/sessions.ts` `surface` filter (sqlString, like `agent`);
  `routes/projects.ts` per-project surface counts; CLI `sessions --surface`;
  MCP `list_sessions` `surface`; `agent/query.ts` plumbing.

Acceptance: extends `test/surface.integration.test.ts` — the filter returns
only matching sessions with a correct `X-Total-Count`; project counts are
disjoint and exclude surface-less sessions; CLI and MCP pass the parameter
through (`cli-query.test.ts` / `mcp.integration.test.ts` pattern).

**C4 — Web filter and badge** (simple, Jev 0.96 → Sonnet)

- `web/src/pages/browse/SessionList.tsx`: a "Started from" button group
  mirroring the agent filter, shown when the project has 2+ surfaces, with
  counts, sending `surface`; a row badge for non-`cli` surfaces; label map
  (`cli` → CLI, `claude-desktop` → Desktop, `claude-vscode` → VS Code,
  `sdk-*` → SDK), raw value as fallback.

Acceptance (worker): typecheck. Acceptance (orchestrator, after Wave 3):
`/verify` with a sandboxed project holding 2 CLI
sessions, 1 desktop session and 1 Codex session: the group shows All 4 · CLI 2
· Desktop 1, the desktop row carries the badge, and picking Desktop lists one
session (Playwright screenshot).

### Orchestrator

- Plan file + index row; `docs/cli.md`, `plugins/claudescope/README.md`,
  history `SKILL.md` gain `--surface`; markdownlint on changed `.md`.

## Files affected

- `packages/server/src/data/project-id.ts`, `data/index.ts`, `db/schema.ts`,
  `routes/sessions.ts`, `routes/projects.ts`, `agent/shape.ts`,
  `agent/query.ts`, `agent/mcp.ts`, `cli.ts`, `connectors/types.ts`,
  `connectors/claude-code/claude-code.ts`, `data/agent-capabilities.ts`
- `packages/shared/src/api.ts`
- `packages/web/src/pages/browse/SessionList.tsx` (+ its CSS if needed)
- `packages/server/test/*` new/extended tests; `CLAUDE.md`; docs above

## Testing

`npm test`, `npm run typecheck`; `/verify` against sandboxed fixtures for the
web list; each new test is checked to fail with its fix reverted.

## Outcome

Landed as planned, with these deviations:

- **The surface moved from the `surfaces` aux table to an `events.entrypoint`
  column** (supersedes the decision above). The aux projection read every
  Claude Code transcript a second time; the CI perf gate measured cold
  indexing 10.8% slower (p = 0.001), and disabling only that projection
  recovered it locally. The column costs one line in the Claude Code
  projection and one `NULL` in the shared canonical projection (the other
  seven connectors use it), not eight connector changes; `rebuildSessions`
  derives the same "started from" value from `events`, and reload/delete
  follow the existing per-file `events` swap.
- `sessions.cwd` is computed with `arg_min` over a sortable key instead of a
  window sort (final review measured 141 ms → 7 ms on 3M rows, same result).
- `ProjectMeta.surfaces` is required (always an array, like `agents`).
- The web group carries a visible "Started from" caption, resets when the
  project changes or the selected value disappears, and labels SDK variants
  `SDK (<lang>)` so they stay distinct. "All" carries no count, as in the
  agent filter.
- No CLI/MCP pass-through tests: the existing suites assert no other filter's
  pass-through either; the HTTP filter is covered.
- Only `docs/cli.md` gained `--surface`; the plugin README and history skill
  show a resume recipe, not the flag list.
- `/verify` ran with 2 CLI sessions, 1 desktop worktree session and 1 session
  without `entrypoint` (no Codex fixture): CLI 2 · Desktop 1, the Desktop badge,
  the worktree session under the repo project with resume inside the worktree,
  and the renamed titles.

## Risks / open questions

- Six existing project ids change (accepted). Bookmarked worktree-project URLs
  stop resolving. Twelve resume commands change, all to the correct directory.
- Worktrees placed outside `<repo>/.claude/worktrees` (desktop setting) don't
  fold — documented limitation.
- Sessions with no recorded `entrypoint` (older Claude Code) have no surface
  and appear only under "all" in the filter.
