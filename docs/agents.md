# Supported agents

Claudescope reads each agent's transcripts from its home directory and never writes to them.
Every source is optional: a directory that doesn't exist is skipped. To point a source somewhere else, see
[Configuration](configuration.md); to add another agent, see
[adding an agent connector](../CONTRIBUTING.md#adding-an-agent-connector).

| Agent | Transcripts read from |
| ------------------------------------------------- | --------------------------------------------- |
| [Claude Code](https://claude.com/claude-code)     | `~/.claude/projects/**/*.jsonl`               |
| [OpenAI Codex](https://openai.com/codex)          | `~/.codex/sessions/**/rollout-*.jsonl`        |
| [JetBrains Junie](https://www.jetbrains.com/junie/) | `~/.junie/sessions/session-*/events.jsonl`  |
| [pi](https://pi.dev)                              | `~/.pi/agent/sessions/**/*.jsonl`             |
| [opencode](https://opencode.ai)                   | `~/.local/share/opencode/opencode.db` (SQLite) |
| [GitHub Copilot CLI](https://github.com/features/copilot) | `~/.copilot/session-state/**/events.jsonl` |
| [Google Antigravity](https://antigravity.google) | `~/.gemini/antigravity-cli/brain/**/transcript_full.jsonl` |
| [xAI Grok CLI](https://x.ai) | `~/.grok/sessions/**/chat_history.jsonl` |

## What each agent records

Formats differ, so the same view can look different per agent. What an agent does not record shows as
"not recorded" or *n/a*, never as a fake zero.

- **Thinking blocks** appear empty because Claude Code stores only a signature
  (and Codex only encrypted reasoning), not the plaintext — the app notes this
  explicitly. (Not a bug.)
- **Codex sessions have no stored title**, so the title falls back to the first
  user message. The same is true for **pi** sessions.
- **Junie sessions render differently.** Junie records an event-sourced UI stream
  rather than a chat log, so a session reads as tool / terminal / file blocks plus
  a final result — there's no assistant prose or thinking to show. Pasted
  screenshots are surfaced inline. Older Junie sessions don't record a working
  directory and group under an **"(unknown — Junie)"** project.
- **pi reasoning renders in full.** Unlike Claude Code / Codex, pi stores the
  plaintext of its thinking blocks, so they show real reasoning rather than an
  empty placeholder. pi keeps no memory in its home dir, so it contributes nothing
  to the memory viewer.
- **opencode is SQLite-backed.** opencode stores all sessions in one read-only
  SQLite database (`opencode.db`), not per-session files; Claudescope reads it via
  Node's built-in `node:sqlite`. Its reasoning renders in full (plaintext), its
  file edits (made via `apply_patch`) show in the **Files changed** tab and as
  diffs, and pasted screenshots embed. Like pi, it contributes no memory.
- **GitHub Copilot CLI records an event-sourced stream**
  (`~/.copilot/session-state/<id>/events.jsonl`). Cost is **session-level** — only
  a cleanly-closed session reports tokens, so a crashed or still-running one shows
  no cost. Reasoning is encrypted (renders empty, like Codex). File edits show in
  the **Files changed** tab; a denied edit is shown but doesn't count as a change.
  Pasted screenshots embed when screenshot-saving is enabled (otherwise a marker
  remains). Its global `copilot-instructions.md` appears in the memory viewer; it
  keeps no per-project memory.
- **Google Antigravity carries no cost data.** Antigravity transcripts store no
  token counts (its per-conversation database is opaque protobuf), so tokens and
  cost are unavailable by design and show as zero / —. Reasoning renders in full —
  like pi, it stores the plaintext of its thinking blocks. Subagents run as
  separate conversations and are shown nested under the call that spawned them.
- **xAI Grok CLI spreads a session across three files** (`chat_history.jsonl` +
  `updates.jsonl` + `summary.json`). Timestamps and token usage come from
  `updates.jsonl` (recorded once per user turn), so a session whose updates file
  is missing or truncated still renders but reports zero tokens. Reasoning
  **summaries** render in full (plaintext, like pi). File edits show in the
  **Files changed** tab, pasted screenshots embed, and subagents run as sibling
  sessions shown nested under the call that spawned them. Grok's experimental
  memory is not surfaced.
