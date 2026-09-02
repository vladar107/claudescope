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
agent transcript files itself; it contains no bundled MCP server, but it does
ship an optional `SessionStart` hook (see below) that runs the same read-only
CLI.

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

## Compaction hook

The plugin ships one `SessionStart` hook (`hooks/hooks.json`), matched to
`compact` only. Right after a context compaction it injects a single line: the
pre-compaction transcript is still indexed locally, and the command to read its
end (`claudescope session <id> --tail 20 --redact`). It answers from the
harness payload alone — no daemon, git, or network access, so it cannot block a
session — and prints nothing when `claudescope` is not on `PATH`.

It deliberately does not run on `startup`, `resume`, or `clear`. Injecting
earlier sessions there puts untrusted session titles into every session's
context whether or not the work continues anything, and `clear` is the user
asking for a fresh context. Those moments are covered on demand by the history
skill's resume recipe (`claudescope sessions --cwd … --branch …`).

Codex requires `hooks = true` under `[features]` in `~/.codex/config.toml`, and
gates new or changed hooks behind a one-time trust step: run `/hooks` once to
review and trust it. Claude Code has no way to disable a single plugin hook;
set `CLAUDESCOPE_HOOKS=0` in the environment, or uninstall the plugin, to turn
it off there.

Nothing leaves the machine and nothing untrusted enters the context: the
injected line contains only the harness's own session id.

### Weekly digest

For a push rather than pull workflow, cron a weekly digest:

```cron
0 9 * * 1 claudescope digest > "$HOME/claudescope-digest.md"
```

`claudescope digest` defaults to the last seven calendar days ending today;
pass `--from`/`--to` for an exact calendar week.

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
