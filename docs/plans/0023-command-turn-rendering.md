# 0023 — Structured rendering for command turns

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-17
- **PR:** <link, once opened>

## Context

Claude Code records slash commands and `!` bash escapes by embedding XML-style
markers directly in user message *text* — `<command-name>`, `<command-message>`,
`<command-args>`, `<bash-input>`, `<bash-stdout>`, `<bash-stderr>`,
`<local-command-stdout>` (the last often carrying raw ANSI escapes). The reader
detected these as harness/system turns (`classifySystemText`) and collapsed them
behind a generic label, but the expanded body printed the transcript text
**verbatim** via `ClampedText`. The result, on every such turn:

- literal tags shown as text (e.g. `<command-name>/clear</command-name>`),
- the stray 12-space indentation baked into Claude Code's command format,
- raw ANSI escapes rendering as garbage (`[1mOpus 4.7[22m`),
- a generic header ("Slash command") that never said *which* command.

These tags are **Claude-Code-specific**. Verified against the connector source
and real on-disk transcripts: Codex, Junie, pi, opencode, and Copilot all record
shell/slash interactions as real tool calls or plain text (pi even stores `/exit`
as plain text), so none produce these tags. The fix is therefore Claude-Code-only
and must be a clean no-op for everything else.

## Goal

Command turns render as clean command/terminal UI — the actual command visible in
the collapsed header, tags and ANSI stripped — while non-command system turns and
all other agents fall through to the existing verbatim rendering unchanged.

## Decisions

- **Parse in a pure helper, render in the view** — added `parseCommandTurn()` +
  `stripAnsi()` to `pages/session/text.ts` (mirrors the existing
  `stripImageMarkers` pattern: no React/DOM deps, cheap to unit-test). Returns a
  discriminated union or `null`.
- **`null` for anything unrecognized** — non-command system turns
  (task-notification, system-reminder), truncated/unclosed tags, plain text, and
  pi-style plain `/exit` all return `null` and keep the old `ClampedText` path.
  This is the safety contract that keeps other agents untouched.
- **Drop the redundant `<command-message>`** — it just repeats the command name
  without the slash; the name + args carry everything.
- **Surface the command in the collapsed header subtitle** — so `/plugin
  marketplace add …` or `git pull` is legible without expanding.
- **Did NOT merge bash input with its output** — `<bash-input>` and
  `<bash-stdout>`/`<bash-stderr>` are *separate* parent/child transcript turns;
  fusing them into one terminal block needs cross-turn correlation in the parser.
  Left as a possible follow-up; each turn renders cleanly on its own.

## Approach

1. `text.ts`: `stripAnsi()`, `tagContent()` (newline-tolerant single-tag
   extractor), `parseCommandTurn()` → `slash | bash-input | bash-output |
   local-output | null`.
2. `ThreadView.tsx`: `SystemTurn` parses the turn; on a hit it sets the header
   subtitle to the command and renders `CommandBody` (slash pill / `$`-prompt
   line / stdout+stderr blocks / ANSI-stripped local output), else the old
   `ClampedText`.
3. `session.css`: small classes (`.tv-cmd__slash`, `.tv-cmd__prompt`,
   `.tv-cmd__stderr`, …) reusing existing mono/accent/danger tokens.
4. Tests in `web/test/text.test.ts` cover the bug-prone edges.

## Files affected

- `packages/web/src/pages/session/text.ts` — parsers + `stripAnsi`.
- `packages/web/src/pages/session/ThreadView.tsx` — structured `SystemTurn`
  rendering (`CommandBody`, `CommandOutput`, `commandSubtitle`).
- `packages/web/src/pages/session/session.css` — command/terminal styling.
- `packages/web/test/text.test.ts` — parser unit tests.

## Testing

- `npm test` — 201 pass (8 new cases: empty/with args slash, bash-input,
  multiline stdout, stderr-only, ANSI strip, truncated-tag → null, plain-text &
  pi-`/exit` → null).
- `npm run typecheck` — clean.
- Manual: open a Claude Code session with slash/bash turns and confirm the header
  shows the command and the body is tag/ANSI-free; confirm a Codex/pi session is
  unchanged.

## Risks / open questions

- bash input/output remain two adjacent collapsibles (see decision above) —
  optional future merge.
- `stripAnsi` targets CSI/SGR sequences; exotic escapes (OSC hyperlinks) are left
  as-is, acceptable for the observed data.
