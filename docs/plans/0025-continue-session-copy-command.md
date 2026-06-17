# 0025 — Continue session: copy the command

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-17
- **PR:** [#31](https://github.com/vladar107/claudescope/pull/31)

## Context

Supersedes [0024](./0024-continue-session.md), which tried to have the server
**auto-open** the user's terminal. That was abandoned: macOS has no reliable
"default terminal" (a `.command` launcher always lands in Terminal.app, slowly),
and an endpoint that writes+executes a script is a localhost-CSRF risk — a real
escalation away from a read-only viewer. See 0024 for the full write-up and the
verified per-agent CLI research.

What survives is the useful, safe half: we already know each session's agent
(`connectorId`) and its native id, so we can show the exact command to reopen it.
The user copies it and runs it in whatever terminal they already have.

## Goal

From a session view, a **Continue** dropdown shows the command to reopen the
session in its agent's own CLI — **Resume** (append) for every agent, plus
**Fork** (new session) for the agents whose CLI supports it — each with a Copy
button. Same on every platform. The server only builds and returns strings; it
never spawns anything.

## Decisions

- **Copy-only, no auto-open** — the server returns command strings; the UI shows
  them with a Copy button. Drops the `POST /continue` endpoint, the `.command`
  launcher, and the `open` spawn entirely, so the server stays fully read-only.
  This is the whole point of the supersession (see 0024's abandonment note).
- **All agents, per-connector** — an optional `resumeSpec()` on the connector
  port returns the argv; the agent is taken from `connectorId`, never guessed.
  Resume for all six; fork only where the CLI supports it (Claude Code, Codex,
  opencode, pi — not Copilot or Junie).
- **Verified per-agent commands** (carried over from 0024's research):
  `claude --resume <id>` (`--fork-session`), `codex resume <id>` / `codex fork`,
  `opencode --session <id>` (`--fork`), `pi --session <id>` / `pi --fork`,
  `copilot --resume <id>`, `junie --session-id <id>`. Wrapped as
  `cd <cwd> && <cmd>`.
- **No id remapping needed** — every connector already indexes the agent's native
  id as `session_id`, so `resumeSpec` uses it verbatim.
- **Shell-quote the cwd** — the only free-form value in the command. `shQuote`
  (shlex-style: bare when safe, else single-quoted with `'\''` escaping) keeps a
  hostile cwd inert even though the string is only ever displayed.

## Approach

1. **Shared** (`packages/shared/src/api.ts`): `ResumeInfo { cwd, resumeCommand,
   forkCommand? }` and optional `resume?` on `SessionDetailResponse`.
2. **Connector port** (`connectors/types.ts`): optional
   `resumeSpec(sessionId): ResumeSpec | null` with `ResumeSpec { resumeArgv,
   forkArgv? }`; implement on all six connectors.
3. **Pure builder** (`connectors/resume.ts`): `shQuote`, `displayCommand`,
   `buildResumeInfo` — no side effects.
4. **Route** (`routes/sessions.ts`): attach `resume` to the session detail
   response (via `buildResumeInfo`). No new endpoint.
5. **Web**: `ContinueMenu` dropdown next to Export — shows the resume command
   (and fork command when present) with Copy buttons; rendered when
   `data.resume` is set.

## Files affected

- `packages/shared/src/api.ts` — `ResumeInfo`, `resume?` on `SessionDetailResponse`.
- `packages/server/src/connectors/types.ts` — `resumeSpec()` + `ResumeSpec`.
- `packages/server/src/connectors/{claude-code,codex,opencode,pi,copilot,junie}/*.ts`
  — implement `resumeSpec`.
- `packages/server/src/connectors/resume.ts` *(new)* — pure command builders.
- `packages/server/src/routes/sessions.ts` — attach `resume` to detail response.
- `packages/web/src/api/client.ts` — (no new method; `resume` rides on the detail).
- `packages/web/src/pages/session/ContinueMenu.tsx` *(new)* + wiring in
  `SessionPage.tsx`; CSS in `session.css`.

## Testing

`npm test` + `npm run typecheck`.

- **Command construction (pure):** cwd quoting/injection (spaces, `$`,
  `'; rm -rf ~ #` stays inert), each connector's resume/fork verbs, fork omitted
  for Copilot/Junie, `buildResumeInfo` returns undefined without a cwd.
- **Integration:** the session detail response carries the right `resume` object
  for a Claude fixture.

## Risks / open questions

- **Native id assumptions** — opencode (`ses_…`) and Junie (`session-…`) ids must
  match what their CLI expects; verified against the indexed `session_id`. Junie
  CLI resuming an *IDE-originated* session is still unconfirmed, but since we only
  display the command, a wrong guess just means the pasted command errors visibly.
- **Windows copy command** — emitted as POSIX `cd … && …`; fine for WSL/git-bash,
  not native `cmd`. Acceptable; not special-cased.
