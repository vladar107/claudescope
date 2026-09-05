# Security Policy

Claudescope is a **local, read-only** viewer for your AI coding-agent transcripts
— Claude Code, OpenAI Codex, JetBrains Junie, pi, opencode, GitHub Copilot CLI,
Google Antigravity, and xAI Grok CLI. It runs on your machine, binds to loopback
only, and is designed to touch as little of your system as possible. This
document describes exactly what it does so you can audit it, and how to report
anything that looks wrong.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub's
[**Security Advisories**](https://github.com/vladar107/claudescope/security/advisories/new)
("Report a vulnerability") rather than a public issue. I'll acknowledge within a
few days and aim to ship a fix promptly.

## Supported versions

Only the **latest** published version receives fixes. Upgrade with
`claudescope update` (or `npm install -g @vladar107/claudescope@latest`).

## What Claudescope does on your system

This is the full picture of its capabilities — useful when a dependency scanner
(e.g. Socket) flags "shell access", "network/URL", or "self-update" signals.
None of these are misused; they're listed here so you can verify that.

### Filesystem

- **Reads** your transcripts from each agent's own directory, every one treated
  as **strictly read-only** — Claudescope never writes to any of them. Each
  source is optional; a directory that doesn't exist is simply skipped:
  - `~/.claude/projects/**` — Claude Code (override: `$CLAUDE_PROJECTS_DIR`)
  - `~/.codex/sessions/**` — OpenAI Codex (override: `$CODEX_SESSIONS_DIR`)
  - `~/.junie/sessions/**` — JetBrains Junie (override: `$JUNIE_SESSIONS_DIR`)
  - `~/.pi/agent/sessions/**` — pi (override: `$PI_SESSIONS_DIR`)
  - `~/.copilot/session-state/**` — GitHub Copilot CLI (override: `$COPILOT_SESSIONS_DIR`)
  - `~/.local/share/opencode/opencode.db` — opencode, a SQLite database opened
    **read-only** via Node's built-in `node:sqlite` (override:
    `$OPENCODE_DATA_DIR` / `$OPENCODE_DB_PATH`)
  - `~/.gemini/antigravity-cli/brain/**` and `~/.gemini/antigravity/brain/**` —
    Google Antigravity CLI and desktop (overrides: `$ANTIGRAVITY_CLI_DIR` /
    `$ANTIGRAVITY_DIR`)
  - `~/.grok/sessions/**` — xAI Grok CLI (override: `$GROK_SESSIONS_DIR`)
- **Reads** agent **memory** live (never indexed) from those same read-only home
  dirs — long-lived instruction files and any agent-distilled memory — strictly
  within each agent's own directory, never from your project folders.
- **Writes** only inside its own state dir `~/.claudescope/` (override:
  `$CLAUDESCOPE_HOME`): the DuckDB index (a rebuildable cache), a user-editable
  `pricing.json`, the daemon PID/port file, and logs. DuckDB's own `json`/`fts`
  extensions land there too, under `~/.claudescope/duckdb-extensions/` (override:
  `$DUCKDB_EXTENSION_DIR`) — the node client doesn't bundle them, so DuckDB
  downloads them itself, and pointing its `extension_directory` here keeps that
  write inside the state dir instead of the default `~/.duckdb/extensions`.
- **Creates that state dir owner-only** (`0700`, files `0600`) — the index, and
  the normalized per-session copies under `cache/`, hold transcript text verbatim.
  Those copies are removed automatically once the source session is gone. The
  daemon also sets `umask 0077` on startup, so files DuckDB creates itself (the
  index and its WAL, written with no explicit mode) come out owner-only too.
  A directory or file an older version created with the default umask keeps its
  old mode, so run `chmod -R go-rwx ~/.claudescope` to tighten those.

### Network

- **Binds to `127.0.0.1` only** (`packages/server/src/index.ts`) — the server is
  never exposed to your LAN or the internet.
- **No authentication** — the API trusts any request that reaches it, so any
  process running under any account on the machine can query it. Claudescope
  assumes a single-user machine; on a shared multi-account host, other local
  users could read your transcripts through it.
- **Rejects non-loopback `Host` headers** (`packages/server/src/security.ts`) —
  a request whose `Host` isn't `localhost`/`127.0.0.1`/`[::1]` gets a `403`. This
  blocks DNS-rebinding attacks, where a malicious site you visit rebinds its own
  hostname to `127.0.0.1` to read your transcripts past the loopback bind. Override
  the allowlist with `CLAUDESCOPE_ALLOWED_HOSTS` for custom local hostnames.
- Shipped code makes exactly **two kinds of outbound request**, with these
  default destinations:
  - a version check against `https://registry.npmjs.org` (cached for 24h) to
    tell you when an update is available; the Settings **Check Update** action
    and `claudescope update` explicitly bypass that cache
    (`packages/server/src/update-check.ts`);
  - a daily fetch of model pricing rates from LiteLLM's public table at
    `https://raw.githubusercontent.com/BerriAI/litellm/…/model_prices_and_context_window.json`
    (`packages/server/src/data/pricing-refresh.ts`), validated and written
    atomically to `~/.claudescope/pricing.fetched.json`. Override the source
    with `LITELLM_PRICING_URL`, or set `PRICING_REFRESH_INTERVAL_MS=0` to
    disable it entirely.

  Both are GET requests that **send no data** beyond the request itself.
- **DuckDB fetches its own extensions.** The index needs the `json` and `fts`
  extensions, which the node client doesn't bundle, so on first run — and again
  after a DuckDB version bump — DuckDB downloads them (~31 MB) into
  `~/.claudescope/duckdb-extensions/` (override: `$DUCKDB_EXTENSION_DIR`). This
  is a GET that sends nothing about you, but note it goes over **plain HTTP** to
  `http://extensions.duckdb.org/<duckdb-version>/<platform>/…` — DuckDB's own
  default endpoint, unencrypted because the extension binaries are
  signature-verified rather than transport-protected. Pre-seed that directory (or
  copy it from another machine) to skip the download and run fully offline.
- **No telemetry, analytics, or data exfiltration.** Your transcript content
  never leaves your machine.
- The only other URLs in the repository (`example.com`, `platform.claude.com`)
  live in **maintainer-only dev scripts under `scripts/`**, which are **not
  included in the published package**.

### Shell / process execution

Claudescope uses `node:child_process` for its lifecycle commands. Every command
is a **hardcoded constant passed as an argument array** (no string concatenation,
no user-controlled input → no shell-injection surface):

- launch the background server (`spawn(process.execPath, …)`)
- open your browser on `start` (`open` / `xdg-open` / `start`)
- self-update (`npm install -g …`)
- tail logs (`tail -f …`)
- post-upgrade self-restart: every 5 minutes the daemon runs the installed
  `claudescope version` and, if it differs from the running version,
  `claudescope restart --no-open` — but only when that binary's real path lies
  inside the daemon's own install root (`packages/server/src/self-restart.ts`),
  so a writable directory on `PATH` can never be executed. Disable with
  `SELF_RESTART_INTERVAL_MS=0` or `CLAUDESCOPE_AUTO_RESTART=0`.

`shell: true` is set **only on Windows**, where the `start` builtin and `.cmd`
shims require it.

### Self-update

- `claudescope update` is **opt-in** — it only runs when you invoke it. The
  `status` command merely *prints* a notice when a newer version exists; it never
  installs anything on its own.
- It installs the **hardcoded** package `@vladar107/claudescope@latest` and asks
  for confirmation first (skip with `-y`/`--yes`). The package name is never
  derived from user input.
- The package is published via **npm Trusted Publishing (OIDC)**, so releases
  carry **provenance attestation**; npm verifies tarball integrity on install.
  You can audit it with `npm audit signatures`.
