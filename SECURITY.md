# Security Policy

Claudescope is a **local, read-only** viewer for your Claude Code transcripts.
It runs on your machine, binds to loopback only, and is designed to touch as
little of your system as possible. This document describes exactly what it does
so you can audit it, and how to report anything that looks wrong.

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

- **Reads** your transcripts from `~/.claude/projects/**` (override:
  `$CLAUDE_PROJECTS_DIR`). This directory is treated as **strictly read-only** —
  Claudescope never writes to `~/.claude`.
- **Writes** only inside its own state dir `~/.claudescope/` (override:
  `$CLAUDESCOPE_HOME`): the DuckDB index (a rebuildable cache), a user-editable
  `pricing.json`, the daemon PID/port file, and logs.

### Network

- **Binds to `127.0.0.1` only** (`packages/server/src/index.ts`) — the server is
  never exposed to your LAN or the internet.
- The **only outbound request** in shipped code is a version check against
  `https://registry.npmjs.org` (cached for 24h) to tell you when an update is
  available (`packages/server/src/cli.ts`).
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
