# Agent access

Four ways to let a coding agent, or you, query Claudescope's index: an MCP
server, a Claude Code and Codex plugin, Raycast, and the [CLI](cli.md).

## MCP server

Claudescope doubles as an MCP server, so a coding agent can query its own
history — "have I hit this error before?", "what did we decide last month?":

```bash
claude mcp add claudescope -- claudescope mcp
```

`claudescope mcp` speaks MCP over stdio and starts the background server on
first use if it isn't already running. Tools: `search_transcripts` (full-text
search with snippet hits), `list_sessions` / `list_projects` (compact listings),
`get_session` (a windowed Markdown slice of one session — pageable, tool
payloads truncated), `get_analytics` (token/cost aggregates, or tool/skill call
counts), and `get_memory` (instruction files + distilled agent memory). Output is
plain text sized for an agent's context window; pass `redact: true` to mask home
paths and likely secrets. Everything stays read-only and on localhost.

## Claude Code and Codex plugin

For a plugin path that needs no MCP registration, install the repository's
shared plugin (the `claudescope` CLI must already be on `PATH`). In Claude Code:

```text
/plugin marketplace add vladar107/claudescope
/plugin install claudescope@claudescope
/reload-plugins
```

In Codex:

```bash
codex plugin marketplace add vladar107/claudescope
codex plugin add claudescope@claudescope
```

The shared `/claudescope:history` (Claude Code) or `$claudescope:history`
(Codex) skill teaches the model when to use the read-only query CLI for prior
solutions, decisions, session inspection, usage analytics, and dated work
digests. It keeps searches and session windows narrow; transcript results enter
the current conversation context. The plugin is the minimal setup, while
`claudescope mcp` remains the structured, typed option for MCP-capable clients.
The plugin also ships a small `SessionStart` hook that fires only after a
context compaction and injects the command to read the pre-compaction
transcript; see the [plugin guide](../plugins/claudescope/README.md) for its
behavior, opt-out, and local development.

## Raycast

<a href="https://www.raycast.com/vladar107/claudescope"><img src="https://www.raycast.com/vladar107/claudescope/install_button@2x.png?v=1.1" height="64" alt="Install Claudescope from the Raycast Store"></a>

On macOS, the [Raycast extension](https://www.raycast.com/vladar107/claudescope)
searches the sessions Claudescope has indexed and opens the exact matching
message in the web app. Commands: **Search ClaudeScope**, **ClaudeScope Recent
Sessions**, and **Open ClaudeScope**. It needs Claudescope 0.17.0 or later on
`PATH`; if it can't find the executable, set its absolute path in the extension
preferences.
