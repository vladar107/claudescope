# ClaudeScope plugin for Claude Code and Codex

Search and analyze local coding-agent transcript history from Claude Code or
Codex. The plugin adds one model-invocable `history` skill, which uses
ClaudeScope's existing read-only query CLI.

## Requirements

- A current Claude Code or Codex version with plugin support.
- The `claudescope` CLI on `PATH`. Choose npm, Homebrew, or Nix from the
  [ClaudeScope Quick Start](https://github.com/vladar107/claudescope#quick-start).
  npm requires Node.js 22.13+:

  ```bash
  npm install -g @vladar107/claudescope
  ```

ClaudeScope starts its local daemon on the first query. The plugin does not read
agent transcript files itself and contains no hooks or bundled MCP server.

## Install in Claude Code

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

## Install in Codex

Run these commands in a terminal:

```bash
codex plugin marketplace add vladar107/claudescope
codex plugin add claudescope@claudescope
```

Start a new Codex thread so the installed skill is available. Codex can select
it automatically for relevant history questions, or you can invoke it directly:

```text
$claudescope:history have we fixed this DuckDB locking error before?
```

Examples include “what did we decide about this architecture?”, “show my recent
Codex sessions”, “compare token usage by agent last week”, and “summarize what I
worked on yesterday”. `claudescope search` snippets are unredacted and enter the
current conversation context, so the skill keeps searches minimal. Follow-up
windows use `claudescope session --redact` by default, but its path and secret
masking is best-effort rather than a guarantee.

## Skill or MCP?

The plugin is the quickest setup: it teaches the model when to call the
installed CLI through the shell. `claudescope mcp` remains the structured,
typed integration for MCP-capable clients. Both are local and read-only; use MCP
when typed tools and arguments matter, and the plugin when minimal configuration
matters.

## Develop locally

From the ClaudeScope repository root, validate and load the Claude Code side:

```bash
claude plugin validate . --strict
claude plugin validate ./plugins/claudescope --strict
claude --plugin-dir ./plugins/claudescope
```

For Codex, add the local repository as a marketplace source and install the
shared package:

```bash
codex plugin marketplace add .
codex plugin add claudescope@claudescope
```

After editing plugin metadata or skills, refresh or reinstall the plugin and
start a new thread so the current package is loaded.
