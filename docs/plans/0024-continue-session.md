# 0024 — Continue session from transcript (terminal auto-open)

- **Status:** abandoned <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-17
- **PR:** [#30](https://github.com/vladar107/claudescope/pull/30) (closed, not merged)

> **Abandoned.** This plan's distinguishing idea — having the server **auto-open
> the user's terminal** (write a macOS `.command` launcher and `open` it) — does
> not work in practice and was dropped. Two reasons:
>
> 1. **No reliable "default terminal" on macOS.** `open foo.command` routes to
>    whatever handles `.command`, which for virtually everyone is **Terminal.app**
>    (slow cold start), not their iTerm/Ghostty/Warp. A `.sh` extension is worse —
>    `open foo.sh` launches a text editor, not a shell.
> 2. **Security.** The `POST /continue` endpoint writes an executable script and
>    spawns a process to run it; a browser page could `POST` to `localhost:4317`
>    (localhost CSRF) and trigger terminal execution — a real escalation away from
>    a read-only viewer.
>
> The per-connector resume **commands** (`resumeSpec`) and the verified per-agent
> CLI research below are still good and carry forward. Superseded by
> [0025 — copy the command](./0025-continue-session-copy-command.md), which keeps
> the commands but drops auto-open: the UI just shows the command to copy, on every
> platform, and the server stays fully read-only.

## Context

Claudescope is a read-only viewer. A natural next step while reading a transcript
is to **pick the work back up** in the agent that produced it. Every agent we
support can reopen a session from its own store, and **we already know which agent
a session belongs to** (`connectorId`) — so we never guess. We just hand the user
the right command for that agent and (on macOS) launch it.

The hard constraint: **Claudescope must stay read-only w.r.t. agent sources**
(`~/.claude`, `~/.codex`, …). We honor that by never writing to a source
ourselves. Resuming appends to the agent's own store — but the *agent* does that
write, invoked by the user; Claudescope only emits a command and (on macOS) opens
a terminal. Fork mode mutates nothing.

There is no portable "default terminal emulator" API on any OS. But on macOS we
don't need one: `open foo.command` routes a shell-script file to whatever app is
registered as the handler for `.command` (Terminal.app by default, or the user's
chosen iTerm/Ghostty/…). That *is* their default terminal as the OS sees it, and
it runs through a login shell, so the agent binary resolves on `PATH` normally.

**Verified resume CLIs (June 2026 docs/repos).** All six supported agents have a
non-interactive, by-id resume command; four also have a fork that leaves the
original untouched:

| Agent | Resume (append) | Fork (new session) | id passed |
| --- | --- | --- | --- |
| Claude Code | `claude --resume <id>` | `claude --resume <id> --fork-session` | `.jsonl` filename UUID |
| Codex | `codex resume <id>` | `codex fork <id>` | rollout filename UUID |
| opencode | `opencode --session <id>` | `opencode --session <id> --fork` | `ses_…` id |
| pi | `pi --session <id>` | `pi --fork <id>` | session id (partial ok) |
| Copilot CLI | `copilot --resume <id>` | — (no CLI fork) | `session-state/<uuid>` dir name |
| Junie | `junie --session-id <id>` | — (no CLI fork) | `session-…` id |

Each is wrapped as `cd '<cwd>' && <command>`. cwd is strictly required only for
Claude Code (id lookup is scoped to the project dir); for the others it's not
required but we still `cd` so the agent starts in the right project.

## Goal

From a session view, offer **Continue** — **Resume** (append) for every agent,
plus **Fork** (new session) for the agents that support it. On **macOS**, clicking
opens the user's default terminal already running the command. On **every other
platform**, show the exact command with a **Copy** button.

## Decisions

- **All agents, per-connector — never guess** — the agent is known from
  `connectorId`; each connector encodes its own resume command via an optional
  `resumeSpec()` on the `AgentConnector` port. No `if connectorId === …` branching
  in routes/UI; adding/adjusting an agent is a one-connector change.
- **Resume for all six; fork only where verified** — Claude Code, Codex,
  opencode, pi have a real fork/branch CLI; Copilot CLI and Junie don't (Copilot's
  `/fork` is an in-session command, version-dependent and broken in some builds;
  Junie's CLI has no fork flag). The Fork item appears only when the connector's
  spec provides a fork command. Rejected: a cross-agent "handoff prompt" — lossy,
  not asked for in v1.
- **No install / PATH precheck — just try to launch** — we do not probe for the
  agent binary, its version, or whether the session is resolvable. We build the
  command and run it; if the binary is missing or the agent can't find the
  session, the terminal shows the error. Simpler, and avoids a brittle probe that
  could wrongly hide the action.
- **macOS auto-open via a `.command` launcher + `open`** — respects the user's
  default terminal without detecting it; login-shell `PATH` resolves the agent.
  Rejected: spawning the agent directly from the server (non-login `PATH` often
  can't find the binary, and no visible window); hardcoding Terminal.app (ignores
  the user's choice); an embedded xterm.js terminal (heavy new surface for v1).
- **Other platforms: copy-command only** — Linux has no reliable default-terminal
  mechanism and Windows' is awkward to read; we degrade to a Copy button rather
  than half-implement auto-open.
- **Server is the single source of truth for the command** — the browser sends
  only `{ mode }`; the server builds argv from the **indexed** `sessionId`/`cwd`
  via the connector, never from a client-supplied string. This keeps the new exec
  endpoint from becoming a "run anything" hole — a real concern to constrain even
  on a localhost single-user app.
- **Launcher lives in `~/.claudescope/launchers/`** — app-owned state, never an
  agent source. Overwritten per `(session, mode)`; chmod `700`.

## Approach

1. **Shared types** (`packages/shared/src/api.ts`): add an optional `resume`
   field to `SessionDetailResponse`:
   ```ts
   export interface ResumeInfo {
     cwd: string;
     /** POSIX command that appends to the original session. */
     resumeCommand: string;
     /** POSIX command that forks into a new session; absent when unsupported. */
     forkCommand?: string;
     /** True when this server can open a terminal itself (macOS only). */
     canAutoOpen: boolean;
   }
   ```
   Present for every session whose connector implements `resumeSpec` (all of them,
   at launch). Add `ContinueRequest { mode: 'resume' | 'fork' }` /
   `ContinueResponse { launched: boolean }` for the new endpoint.

2. **Connector port** (`connectors/types.ts`): add
   ```ts
   /** Optional: how to reopen this session in the agent's own CLI, or null. */
   resumeSpec?(sessionId: string, cwd: string): ResumeSpec | null;
   interface ResumeSpec {
     cwd: string;
     /** argv to exec in cwd, e.g. ['claude','--resume','<id>']. */
     resumeArgv: string[];
     /** fork argv; omit when the agent has no CLI fork. */
     forkArgv?: string[];
   }
   ```
   Structured argv (not a pre-joined string) so the copy command and the launcher
   script are both derived without re-quoting twice. The connector maps **our**
   indexed `sessionId` to the agent's native resume id — important for opencode
   (`ses_…`) and Junie (`session-…`), where the native id may differ from a naive
   filename slug.

3. **Per-connector `resumeSpec`** (one method each):
   - `claude-code`: `['claude','--resume',id]` / `['claude','--resume',id,'--fork-session']`
   - `codex`: `['codex','resume',id]` / `['codex','fork',id]`
   - `opencode`: `['opencode','--session',nativeId]` / `[…,'--fork']`
   - `pi`: `['pi','--session',id]` / `['pi','--fork',id]`
   - `copilot`: `['copilot','--resume',id]` (no fork)
   - `junie`: `['junie','--session-id',id]` (no fork)

4. **Command construction** (new `connectors/resume.ts` — pure, testable): given a
   `ResumeSpec`, produce (a) the POSIX display command `cd <q(cwd)> && <q(argv)>`
   and (b) the `.command` launcher body. A single `shQuote()` helper (single-quote
   + `'\''` escaping) handles arbitrary cwd paths; argv tokens are quoted the same
   way.

5. **Session detail route** (`routes/sessions.ts`): the handler already has the
   session row → read `project_cwd`, resolve the connector, call
   `resumeSpec(id, cwd)`. If non-null, attach `resume` to the response (commands
   from step 4; `canAutoOpen = process.platform === 'darwin'`).

6. **Continue endpoint** (`routes/sessions.ts`):
   `POST /api/sessions/:id/continue` with `{ mode }`. Guards: 404 unknown session;
   400 if the connector has no `resumeSpec` or `mode === 'fork'` without a fork
   argv; 400 with a clear "macOS-only — use Copy" message when
   `process.platform !== 'darwin'`. On success: write the launcher to
   `~/.claudescope/launchers/<mode>-<id>.command` (script = `#!/bin/bash` +
   `cd <q(cwd)> &&` + `exec <q(argv)>`), `chmod 0700`,
   `spawn('open', [path], { detached:true }).unref()`, return `{ launched: true }`.
   **No install/existence checks** beyond these — a missing binary surfaces in the
   terminal. Keep the spawn behind a thin, injectable seam so command-building
   stays unit-testable without launching anything.

7. **Paths** (`paths.ts`): add `launchersDir()` under the app home; ensure it
   exists before writing.

8. **Web client** (`api/client.ts`): add `continueSession(id, mode)`.

9. **Web UI** (`pages/session/`): a `ContinueMenu` next to `ExportMenu` in the
   session header (`SessionPage.tsx:366`), mirroring `ExportMenu`'s dropdown.
   Rendered whenever `data.resume` is present (all agents). Item **Resume** always;
   **Fork to new session** only when `resume.forkCommand` exists.
   - `canAutoOpen` → click POSTs `/continue`; toast on success ("Opening in your
     terminal…"), and on error fall back to showing the command + Copy.
   - else → reveal the command with a Copy-to-clipboard button and a "Run this in
     your terminal" hint.

## Files affected

- `packages/shared/src/api.ts` — `ResumeInfo`, `resume?` on
  `SessionDetailResponse`, `ContinueRequest`/`ContinueResponse`.
- `packages/server/src/connectors/types.ts` — optional `resumeSpec()` + `ResumeSpec`.
- `packages/server/src/connectors/{claude-code,codex,opencode,pi,copilot,junie}/*.ts`
  — implement `resumeSpec` for each.
- `packages/server/src/connectors/resume.ts` *(new)* — `shQuote`, display-command
  and launcher-script builders (pure).
- `packages/server/src/routes/sessions.ts` — attach `resume` to detail response;
  add `POST /api/sessions/:id/continue`.
- `packages/server/src/paths.ts` (or equivalent) — `launchersDir()`.
- `packages/web/src/api/client.ts` — `continueSession()`.
- `packages/web/src/pages/session/ContinueMenu.tsx` *(new)* + wiring in
  `SessionPage.tsx`; small CSS in `session.css`.

## Testing

`npm test` + `npm run typecheck`. Focus on the bug-prone edges, not glue:

- **Command construction (pure, the core):** for each connector's spec, the
  resume/fork argv produce the expected POSIX command and launcher body; a cwd
  with spaces, quotes, `$`, and an injection attempt (`'; rm -rf ~ #`) stays inert
  inside the single-quote escaping.
- **Per-connector mapping:** each connector returns the right verb/flag
  (`resume`/`fork` for Codex, `--session`/`--fork` for opencode, `--session-id`
  for Junie, no `forkArgv` for Copilot/Junie). opencode maps the indexed id to its
  `ses_…` native id.
- **Endpoint guards:** unknown id → 404; `mode:'fork'` on a fork-less connector →
  400; non-darwin platform (simulated via the platform seam) → 400 "macOS-only";
  invalid `mode` → 400. The `open` spawn is stubbed — no real launch in tests.
- Manual (macOS): for at least Claude Code and one other agent, Resume opens the
  default terminal in the right cwd; Fork (where present) adds the fork flag and
  the original transcript is unchanged.

## Risks / open questions

- **Shell-injection via cwd** — the one real safety issue; mitigated by `shQuote`
  on every interpolated value and never accepting a command string from the
  client. Covered by tests.
- **opencode native id** — the connector must pass the real `ses_…` id, not the
  synthetic `<dbPath>#<id>` discovery key. Verify what the index stores as
  `session_id` for opencode and map accordingly.
- **Junie IDE-session interop** — `junie --session-id` is verified for Junie *CLI*
  sessions; it's unconfirmed whether it can reopen an *IDE-originated* session
  (what our connector reads). Per the "just try to launch" decision we emit it
  anyway; if it can't, the terminal shows the error. (Also: CLAUDE.md's "Junie is
  IDE-only" note is now outdated — a Junie CLI exists as of ~Apr 2026.)
- **Copilot has no CLI fork** — Fork item hidden for Copilot and Junie; resume
  only.
- **Agent not installed / not on `PATH` / session unresolvable** — by decision we
  don't precheck; the terminal window shows the shell/agent error. Acceptable and
  visible.
- **`open` honors a non-terminal `.command` handler** — if the user remapped
  `.command`, behavior is theirs to own. Acceptable edge.
- **Remote/SSH** — if the server runs on a different host than the browser,
  "open terminal" opens on the *server* host. Out of scope; Claudescope is a local
  single-user tool by design.
- **Windows copy command** — we emit a POSIX `cd … && …` string; fine for
  WSL/git-bash (where these agents typically run), not native `cmd`. Note it; don't
  special-case unless asked.
- **Launcher cleanup** — files are tiny and overwritten per `(session, mode)`;
  prune on write if accumulation ever matters. Minor follow-up.
