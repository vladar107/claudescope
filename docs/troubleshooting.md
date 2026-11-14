# Troubleshooting

- **App is empty / "sessions directory not found"** — none of `CLAUDE_PROJECTS_DIR`,
  `CODEX_SESSIONS_DIR`, `JUNIE_SESSIONS_DIR`, `PI_SESSIONS_DIR`, `OPENCODE_DATA_DIR`, `COPILOT_SESSIONS_DIR`, `ANTIGRAVITY_CLI_DIR`, or `GROK_SESSIONS_DIR` points at real transcripts. Check
  the banner and set them correctly. Any source can be absent; only the present
  ones are indexed.
- **`Error: listen EADDRINUSE :4317`** — the port is taken; run `claudescope --port <n>`.
- **Node version errors** — you need Node ≥ 22.13 (`node -v`).
- **Stale or wrong data** — delete `~/.claudescope/index.duckdb*` and
  `claudescope restart` to rebuild the index from scratch.
- **`@duckdb/node-api` install issues** — it ships prebuilt native binaries;
  re-run `npm install` on a supported platform (macOS, Linux, Windows x64/arm64).
