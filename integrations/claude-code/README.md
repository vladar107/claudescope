# ClaudeScope for Claude Code

Search and analyze local coding-agent transcript history from Claude Code. The
plugin adds one model-invocable skill, `/claudescope:history`, which uses
ClaudeScope's existing read-only query CLI.

## Requirements

- A current version of Claude Code with plugin support.
- The `claudescope` CLI on `PATH`. Choose npm, Homebrew, or Nix from the
  [ClaudeScope Quick Start](https://github.com/vladar107/claudescope#quick-start).
  npm requires Node.js 22.12+:

  ```bash
  npm install -g @vladar107/claudescope
  ```

ClaudeScope starts its local daemon on the first query. The plugin does not read
agent transcript files itself and contains no hooks or MCP server.

## Install

Run these commands inside Claude Code:

```text
/plugin marketplace add vladar107/claudescope
/plugin install claudescope@claudescope
/reload-plugins
```

Claude automatically uses the skill for relevant history questions. You can
also invoke it directly:

```text
/claudescope:history have we fixed this DuckDB locking error before?
```

Examples include “what did we decide about this architecture?”, “show my recent
Codex sessions”, “compare token usage by agent last week”, and “summarize what I
worked on yesterday”. `claudescope search` snippets are unredacted and enter the
current Claude context, so the skill keeps searches minimal. Follow-up windows
use `claudescope session --redact` by default, but its path and secret masking is
best-effort rather than a guarantee.

## Skill or MCP?

The plugin is the quickest Claude Code setup: it teaches Claude when to call the
installed CLI through the shell. `claudescope mcp` remains the structured,
typed integration for MCP-capable clients. Both are local and read-only; use
MCP when typed tools and arguments matter, and the plugin when minimal Claude
Code configuration matters.

## Develop locally

From the ClaudeScope repository root:

```bash
claude plugin validate . --strict
claude plugin validate ./integrations/claude-code --strict
claude --plugin-dir ./integrations/claude-code
```

After editing plugin metadata, restart or run `/reload-plugins`. Claude Code
watches changes to an existing skill's `SKILL.md` during a session.
