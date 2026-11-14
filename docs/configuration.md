# Configuration

All optional — set via environment variables.

| Variable              | Default                | Description                                                            |
| --------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `PORT`                | `4317`                 | Port the app listens on (or `--port <n>`).                             |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects`   | Where to read Claude Code transcripts from. A leading `~` is expanded. |
| `CODEX_SESSIONS_DIR`  | `~/.codex/sessions`    | Where to read OpenAI Codex transcripts from. A leading `~` is expanded.|
| `JUNIE_SESSIONS_DIR`  | `~/.junie/sessions`    | Where to read JetBrains Junie transcripts from. A leading `~` is expanded.|
| `PI_SESSIONS_DIR`     | `~/.pi/agent/sessions` | Where to read pi transcripts from. A leading `~` is expanded.          |
| `OPENCODE_DATA_DIR`   | `~/.local/share/opencode` | Dir holding opencode's `opencode.db` (read-only). Honors `$XDG_DATA_HOME`; override the DB path directly with `OPENCODE_DB_PATH`. |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode`   | opencode's config dir, holding its own `skills/`, `opencode.json(c)`, and `plugins/` (Extensions page, read-only). Honors `$XDG_CONFIG_HOME`. |
| `COPILOT_SESSIONS_DIR`| `~/.copilot/session-state` | Where to read GitHub Copilot CLI transcripts from. A leading `~` is expanded. |
| `ANTIGRAVITY_CLI_DIR` | `~/.gemini/antigravity-cli` | Where to read Google Antigravity transcripts from. A leading `~` is expanded. |
| `ANTIGRAVITY_DIR`     | `~/.gemini/antigravity` | Where to read Google Antigravity desktop-app transcripts from. A leading `~` is expanded. |
| `GROK_SESSIONS_DIR`   | `~/.grok/sessions`     | Where to read xAI Grok CLI transcripts from. A leading `~` is expanded. |
| `CLAUDESCOPE_HOME`    | `~/.claudescope`       | Where the app keeps its own state (index, pricing copy, logs, PID).    |
| `DUCKDB_EXTENSION_DIR`| `~/.claudescope/duckdb-extensions` | Where DuckDB keeps its `json`/`fts` extensions. Point it at `~/.duckdb/extensions` to reuse a machine-wide cache. |
| `REINDEX_INTERVAL_MS` | `15000`                | How often to auto-pick-up new/updated sessions. Set `0` to disable.    |
| `FTS_REBUILD_MIN_INTERVAL_MS` | `60000`       | Minimum gap between full-text index rebuilds while sessions keep changing; the first quiet scan catches up. Set `0` to rebuild on every scan. |

Each agent source is optional — if a directory doesn't exist it's simply skipped,
so the app works whether you use one agent or all eight.

The source directories and the reindex interval can also be changed from the
web UI's **Settings** page — saved to `~/.claudescope/settings.json` and applied
live, no restart needed. Environment variables always override saved settings.

Examples:

```bash
claudescope --port 8080                                  # custom port
CLAUDE_PROJECTS_DIR=/path/to/exported/projects claudescope  # view someone else's transcripts
CODEX_SESSIONS_DIR=/path/to/codex/sessions claudescope   # point at Codex sessions elsewhere
JUNIE_SESSIONS_DIR=/path/to/junie/sessions claudescope   # point at Junie sessions elsewhere
PI_SESSIONS_DIR=/path/to/pi/sessions claudescope         # point at pi sessions elsewhere
OPENCODE_DATA_DIR=/path/to/opencode claudescope          # point at an opencode data dir elsewhere
COPILOT_SESSIONS_DIR=/path/to/copilot/session-state claudescope  # point at Copilot CLI sessions elsewhere
ANTIGRAVITY_CLI_DIR=/path/to/antigravity-cli claudescope # point at Google Antigravity sessions elsewhere
GROK_SESSIONS_DIR=/path/to/grok/sessions claudescope     # point at Grok CLI sessions elsewhere
claudescope --no-open                                    # don't pop a browser tab
```

The startup banner prints the resolved URL and the source directories in use, so
you can always confirm what it's reading.
