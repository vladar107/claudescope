# 0099 — Slim README, reference docs, and the website

- **Status:** done
- **Date:** 2026-11-14
- **PR:** [#140](https://github.com/vladar107/claudescope/pull/140)

## Context

The README had grown to 560 lines: pitch, screenshots, install channels, the full
CLI, agent access, every environment variable, the cost methodology, per-agent
format notes and troubleshooting. It served neither a first-time visitor nor
someone looking up one flag. A product site now exists at
<https://claudescope.ramazaev.dev> to do the selling.

## Goal

A short README that says what Claudescope is, shows it, and gets it installed,
with every reference section kept verbatim in `docs/` and the website linked
wherever a homepage is expected.

## Decisions

- **Reference docs live in this repository, not on the website** — they change
  with the code, so the PR that changes behaviour updates them; the website links
  here. Rejected: docs pages on the website, which would drift and need edits in
  two repositories.
- **Sections move verbatim** — only headings and relative links change, so
  nothing is lost or reworded by accident.
- **Keep the `## Quick start` heading** — the Raycast extension and older links
  point at `#quick-start`.
- **npm `homepage` is the website; the plugin manifests' `homepage` is the
  plugin's own README** — the old `#claude-code-and-codex-plugin` anchor no
  longer exists.

## Approach

1. Split the README into `docs/install.md`, `cli.md`, `agent-access.md`,
   `agents.md`, `configuration.md`, `cost.md`, `usage.md` and
   `troubleshooting.md`, with `docs/README.md` as the index.
2. Rewrite the README with the most eye-catching parts first (the Live
   screenshot and a grid of the other views), then the useful parts (quick
   start for npm, Homebrew and Nix, asking from an agent, Raycast, privacy),
   then navigation to the docs.
3. Point the links that relied on removed README anchors somewhere that exists:
   the CLI help text at `docs/configuration.md`, the plugin README and history
   skill at the website's install section, and the plugin manifests at the
   plugin README.
4. Update CONTRIBUTING's "update every doc that enumerates the agents" list and
   CLAUDE.md's pointer to user-facing docs.

## Files affected

- `README.md` — rewritten, 560 → 146 lines.
- `docs/*.md` — new reference pages and index.
- `package.json` — `homepage` is the website.
- `plugins/claudescope/.claude-plugin/plugin.json`,
  `plugins/claudescope/.codex-plugin/plugin.json` — `homepage` is the plugin README.
- `plugins/claudescope/README.md`, `plugins/claudescope/skills/history/SKILL.md`
  — install links go to the website's install section. They must be absolute
  (the plugin is read from wherever it is installed), and a `blob/main/docs/…`
  URL would 404 until this PR merges.
- `packages/server/src/cli.ts` — the help text links to `docs/configuration.md`.
- `CONTRIBUTING.md`, `CLAUDE.md` — where docs now live.

## Testing

- markdownlint over every changed Markdown file.
- A local check that every relative link and anchor in the README and `docs/`
  resolves.
- `npm run typecheck`, and the CLI and plugin tests.

## Risks / open questions

- External pages that deep-link to removed README anchors (other than
  `#quick-start`) now land at the top of the README.
