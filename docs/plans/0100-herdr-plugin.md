# 0100 — herdr plugin: pane to session, search to resume, cost

- **Status:** done
- **Date:** 2026-11-17
- **PR:** [#141](https://github.com/vladar107/claudescope/pull/141)

## Context

[herdr](https://herdr.dev) runs coding agents in persistent terminal panes and
shows what they are doing now. Claudescope holds what they did. Getting from a
pane to its transcript means leaving the terminal and finding the session by
hand, and resuming an old session means copying an id back.

herdr 0.9.5 plugins are a directory with a `herdr-plugin.toml` manifest whose
actions and panes are argv commands; the herdr CLI is the plugin API. Facts
checked on a live herdr 0.9.5:

- `herdr pane current` / `pane get` carry `agent_session.value` for panes whose
  agent has the herdr integration. For Claude Code it equals Claudescope's
  session id (verified on this session).
- `claudescope session <id> --json` already returns `resume.{cwd,
  resumeCommand, forkCommand?}`, so the plugin needs no per-agent resume logic.
- The herdr server's `PATH` is `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin…`.
  An fnm/nvm-installed `claudescope` is not on it, and neither is the `node`
  its shebang needs.
- `claudescope analytics` silently ignores `--project` for project/model/day/agent
  grouping (only tool/skill usage passes it through); `/api/analytics` has no
  project filter.
- `SearchResult` is one row per message with no agent, date, or cost, and
  `sessions --cwd` is an exact-slug match (no lookup), so a subdirectory finds
  nothing.

Scope is deliberately small (the target user is the maintainer): no live
status, transcript pane, or event hooks, since herdr's own sidebar and panes
already cover them.

## Goal

From any herdr pane: one key opens its session in Claudescope; a popup searches
past sessions across agents and resumes one in a new split; a popup shows the
project's cost. The matching logic lives in a tested, agent-neutral CLI
command, and the plugin is thin glue over it.

## Decisions

- **Same repo, `plugins/herdr/`.** herdr installs from a subdirectory
  (`herdr plugin install vladar107/claudescope/plugins/herdr`) and its
  marketplace indexes manifests in subdirectories of repos tagged
  `herdr-plugin`. CLI contract and plugin change in one PR, beside
  `plugins/claudescope`. Not part of the npm or Nix bundle. Rejected: a
  separate repo (same version skew, more overhead).
- **Session matching is a CLI command, `claudescope resolve`.** It is the only
  part with real edge cases, so it goes where the test suite can reach it, and
  tmux/Raycast/shell callers can reuse it. It composes existing routes in
  `agent/query.ts` (`/api/live`, `/api/projects`, `/api/sessions`): no new
  route and no per-request DuckDB query. Rejected: matching in the plugin with
  `jq`.
- **One project id for the whole plugin.** The plugin calls `resolve` once and
  passes `project.id` as `--project` to every other command, so analytics,
  sessions, and search agree even from a subdirectory. No `--cwd` is added to
  `analytics`.
- **UI, picked from mockups:** fzf picker with a preview (numbered-list
  fallback without fzf); resume opens in a split to the right, focused; cost is
  a popup panel; no exact id → pick when unsure.
- **POSIX `sh` + `jq`.** `jq` required (checked up front), `fzf` optional.
  Rejected: Node scripts (Node is no more reliably on herdr's `PATH` than
  `claudescope` is, and the logic worth testing is in the CLI).
- **Locating the CLI:** `CLAUDESCOPE_BIN` read from the plugin config dir's
  `.env` (parsed for that one key, never sourced), then `PATH`, then known
  install locations (fnm default alias, npm global prefix, Homebrew). The
  binary's directory is prepended to `PATH` so its `node` resolves (and the
  daemon it spawns inherits it). Not found → toast naming the `.env` file.
- **Feature detection, not a version compare:** the plugin probes
  `claudescope resolve`; stderr containing `Unknown command` → toast "upgrade
  claudescope" (a usage error exits 1 too, so the exit code alone can't tell).
  The release number isn't known while coding.
- **Platforms `["linux", "macos"]`, `min_herdr_version = "0.9.5"`** (the only
  version verified).
- No consult was run: each fork had one clearly better option once herdr's
  `PATH` and the existing `resume` payload were checked. Plan critique: Fable,
  two rounds; all blocking items are folded in below.

- **Key bindings ship as an action, `claudescope.install-keys`.** herdr 0.9.5
  has no plugin key declarations and no config include, so the action writes
  a marked `[[keys.command]]` block (prefix+i / f / m, overridable in the
  plugin `.env`) into `config.toml` in place, backing the original up to the
  plugin state dir, and reloads herdr. It skips keys bound elsewhere or taken
  by herdr defaults (`prefix+o` is `open_notification_target`). Rejected:
  README-only (the maintainer wants keys delivered with the plugin) and a
  startup hook that edits the config on every server start.
- **A `[[build]]` step runs `install-keys --build` once on GitHub install.**
  The install preview lists it, so the user sees it before agreeing. A marker
  in the plugin state dir stops `plugin update` (which rebuilds) from
  rebinding keys the user removed. Build steps get no socket env, so the step
  derives its dirs, tries `reload-config` best-effort, reports to stdout, and
  always exits 0. `herdr plugin link` skips it.
- **Cost panel Tab toggles this project / all projects** (added after the
  manual check).
- **Popups print "loading…" at once and run independent CLI calls
  concurrently.** Each call costs ~200–320 ms of Node startup, measured; the
  cost panel's six sequential calls took about 1.4 s.

## CLI contract

### `claudescope resolve [--session <id>] [--cwd <dir>] [--json]`

Read-only; normal daemon startup like other query commands. At least one of
`--session` / `--cwd` is required.

```json
{
  "match": "id | live | recent | ambiguous | none",
  "project": { "id": "…", "cwd": "/abs/path", "match": "exact | ancestor" } | null,
  "sessions": [ { "meta": SessionMeta, "live": true | false }, … ]
}
```

1. `--session` given and `GET /api/sessions/:id` (smallest window) finds it →
   `id`, with `project` set from the session's `meta.projectId` (`match:
   "exact"`, `cwd` from `/api/projects`). Unknown id (404) → fall through to
   `--cwd`. Never `/api/sessions?q=`, which is a substring filter. If that
   session is not live but others in its project are → `ambiguous` (live ones
   first, the id's session last): found in Wave 2, herdr kept reporting a
   pane's pre-`/clear` session id.
2. Project = the known project whose cwd equals `--cwd`, else the nearest
   ancestor, by path segments (`/a/foo` never matches `/a/foobar`), after
   realpath and trailing-slash normalization. An ancestor that is `$HOME` or
   `/` does not count → `none`.
3. Sessions of that project in `/api/live` (its default window): one → `live`;
   several → `ambiguous`, newest first. When `/api/live` reports `truncated`,
   the visible ones are used as-is (the cap is far above one project's live
   count).
4. None live → newest session of the project → `recent`. An agent idle past
   the live window lands here and may pick a newer session in the same
   project; accepted, and the plugin says "matched by folder".

The matching is a pure function (projects + live list + inputs → result) with
unit tests; the command is a thin wrapper. Exit 0 on any `match`, including
`none`; non-zero only for usage or daemon errors, so callers can tell "no
match" from "failed". Human output: one line per candidate, prefixed by the
match kind.

### Other CLI changes

- `analytics --project <id>` filters every grouping (server: optional
  `project` on `/api/analytics` through the existing scope filters; shared
  `AnalyticsQuery` gains `project?`). The web UI and the MCP tool don't send it
  and are unchanged.
- `SearchResult` gains optional session fields named as in `SessionMeta`:
  `connectorId`, `endedAt`, `totalCostUsd` (from the sessions row the search
  route already joins for `title`), so the picker can show agent and date for
  hits in any project.
- `docs/cli.md` states the difference: `sessions --cwd` is an exact project
  match, `resolve --cwd` takes the nearest ancestor project.

### What the plugin calls

| Need | Call |
|---|---|
| pane → session | `resolve --session <agent_session.value> --cwd <foreground_cwd> --json` |
| picker, empty query | `sessions --project <id> --limit 100 --json` |
| picker, typed query | `search <q> --project <id> --json` (Tab: drop `--project`); fzf `--disabled` + `change:reload`, de-duped by `sessionId` |
| preview | `session <id> --tail 8` |
| resume / fork | `session <id> --tail 1 --json` → `resume.cwd`, `resume.resumeCommand` / `forkCommand` |
| cost totals | `analytics --group-by project --project <id> --from <date> --json` for today / 7d / 30d, local time zone |
| live marks, cold daemon | `live --json` (never starts the daemon; exit 3 = not running → toast "starting claudescope…" before the first other call) |
| cost, this pane | `resolve` result `meta.totalCostUsd`, `meta.totalTokens`, `meta.messageCount` |
| cost, top sessions | `sessions --project <id> --sort recent --limit 200 --json`, keep `endedAt` within 7 days, sort by `totalCostUsd`, top 5 |

`SessionMeta` fields used: `id`, `projectId`, `title`, `connectorId`,
`endedAt`, `totalCostUsd`, `totalTokens`, `messageCount`.

## Approach

### Wave 0 — herdr spike (orchestrator)

Link a throwaway probe plugin into the running herdr, record the answers here,
then unlink it:

- What an action and a popup see: `HERDR_PANE_ID`, `HERDR_PLUGIN_CONTEXT_JSON`,
  and how an action passes the source pane id to the popup it opens.
- `herdr pane split … --focus` output (new pane id path).
- `herdr pane run` semantics (types the text plus Enter into the pane's shell).
- Notification behavior and popup sizing.
- Save a sample `herdr pane current` JSON (and the context JSON) as fixtures
  for B's stubs.

Findings (herdr 0.9.5, probe linked and unlinked 2026-11-17):

- Actions and popups both get `HERDR_PLUGIN_CONTEXT_JSON` with
  `focused_pane_id`, `focused_pane_cwd`, `focused_pane_agent`,
  `focused_pane_status`, `workspace_*`, `tab_*`, `invocation_source`. It has no
  `agent_session`, so the session id comes from `herdr pane get
  <focused_pane_id>` → `.result.pane.agent_session.value` (and
  `.foreground_cwd`). An action also gets `HERDR_PANE_ID`; a popup does not,
  but its context still names the source pane, and `plugin pane open --env
  K=V` can pass more.
- `placement = "popup"` with `width`/`height` is accepted in the manifest
  (the `plugin pane open --placement` flag lists only overlay/split/tab/zoomed;
  omit it to use the manifest's). Actions run with no TTY; popups get a TTY
  and `TERM=xterm-256color`. cwd is the plugin root.
- Commands inherit the herdr server's environment; here its `PATH` held an fnm
  multishell dir, which is ephemeral, so the CLI lookup stays.
- `herdr pane split <pane> --direction right --cwd <dir> [--focus|--no-focus]`
  prints `{"result":{"pane":{"pane_id":"w2:p3",…},"type":"pane_info"}}`.
- `herdr pane run <pane> <text>` types the text plus Enter into the pane's
  shell (one argv element; the shell then parses it).
- `herdr notification show <title> [--body …] [--sound none|done|request]`.

`pane current` shape (trimmed): `{"result":{"pane":{"agent":"claude",
"agent_session":{"agent":"claude","kind":"id","source":"herdr:claude",
"value":"<uuid>"},"agent_status":"working","cwd":"…","foreground_cwd":"…",
"pane_id":"w2:p1","tab_id":"w2:t1","workspace_id":"w2","focused":true}}}`.
Panes without an integration omit `agent` and `agent_session`.

### Wave 1 (parallel, file-disjoint)

**A. CLI** — Complex (Jev: complex, 1.0) → Opus worker.
Files: `packages/server/src/agent/query.ts`, `cli.ts` (dispatch, help),
`routes/analytics.ts`, `routes/search.ts`, `packages/shared/src/api.ts`, tests,
`docs/cli.md`, the CLAUDE.md Commands list.

Acceptance:

- Unit tests of the matcher: exact id, unknown id → cwd, subdirectory →
  ancestor, `/a/foo` vs `/a/foobar`, `$HOME` ancestor → `none`, one live →
  `live`, two live → `ambiguous`, none live → `recent`, unknown cwd → `none`.
- One integration test runs `resolve` end to end on synthetic fixtures,
  asserting only `id`, `recent`, and `none` (`live` depends on snapshot
  timing and is covered by the unit tests).
- `analytics --project` total equals that project's row in unfiltered
  `groupBy=project`, for project and day grouping.
- Search hits carry `connectorId`/`endedAt`/`totalCostUsd`.
- `npm test` and `npm run typecheck` pass.

**B. Plugin `plugins/herdr/`** — Complex (Jev: complex, 1.0) → Opus worker,
one worker in order `lib.sh` → open/pick → search → cost (they share
`lib.sh`). Codes against the contract above and the Wave 0 notes.

- `herdr-plugin.toml`: actions `open-session`, `search`, `cost`; popup panes
  `search`, `cost`, `pick`.
- `bin/lib.sh`: locate CLI + `PATH`, require `jq`, feature probe, toast, focused
  pane, control-character stripping.
- `open-session`: toast "starting claudescope…" when the daemon is cold;
  `resolve` → `claudescope open --session <id>`; `ambiguous` → `pick` popup;
  `recent` → toast "matched by folder"; the toast also carries the URL (SSH).
- `search`: rows are tab-delimited with the id in field 1; live sessions are
  marked; Enter resumes, Ctrl-F forks (toast when the agent has no fork), Ctrl-O
  opens in the browser; resuming a live session asks first (two writers).
  Resume = `herdr pane split <pane> --direction right --cwd <resume.cwd>
  --focus`, then `herdr pane run <new> <resumeCommand>` with the command as one
  argv element. Missing `resume` or a vanished cwd → toast.
- `cost`: the panel per the table above; `o` opens Claudescope.
- Security: transcript-derived text (titles, snippets, preview) has control
  and escape characters stripped; nothing is `eval`ed or spliced into `sh -c`.
  fzf `reload`/`execute`/`preview` strings are fixed script paths whose only
  variable parts are fzf placeholders (`{q}`, `{1}`), which fzf quotes.
- Acceptance: `shellcheck` clean; each script runs headless against a stub
  `claudescope` that emits contract fixtures (one per `match` kind), a stub
  `herdr` that logs its argv, and a stub `fzf` that prints a chosen line (real
  fzf needs a TTY); plus a run with no `fzf` on `PATH` for the numbered list.

### Wave 2 — integration (orchestrator)

Review Wave 1. Run the plugin against A's real build with a sandboxed
`CLAUDESCOPE_HOME` and port (as the `verify` skill does), so the version-skew
heal never touches the real daemon. Fix drift. Then the manual checklist on
herdr 0.9.5: a Claude Code pane (exact id), a plain shell pane (folder match),
a directory with two live agents (picker), search → resume into a split, cost
panel. Docs: `plugins/herdr/README.md` (install, keybinding snippet,
`CLAUDESCOPE_BIN`), a short herdr section in `docs/agent-access.md` beside
Raycast, this plan's status and index row. Final review of the whole diff.

## Files affected

- `packages/server/src/agent/query.ts`, `packages/server/src/cli.ts` — `resolve`,
  analytics `--project`.
- `packages/server/src/routes/analytics.ts`, `routes/search.ts`,
  `packages/shared/src/api.ts` — `project` filter, search hit session fields.
- `packages/server/test/…` — matcher unit tests, `resolve` integration test,
  analytics filter test.
- `plugins/herdr/**` — new plugin, with its own stub-based test script.
- `docs/cli.md`, `docs/agent-access.md`, `docs/plans/README.md`, `CLAUDE.md`
  (Commands list).

## Testing

`npm test`, `npm run typecheck`, `shellcheck plugins/herdr/bin/*.sh`, the
plugin's stub test script, markdownlint on changed `.md` files, then the
Wave 2 manual checklist.

## Risks / open questions

- `agent_session.value` equality with Claudescope ids is verified for Claude
  Code only. Other agents fall back to folder matching.
- An agent idle longer than the live window resolves as `recent`, which may be
  a different session in the same project.
- `plugin update` follows `main`, which can be ahead of the released CLI; the
  feature probe covers it.
- After merge (maintainer, manual): tag the repo `herdr-plugin` for the
  marketplace listing.
