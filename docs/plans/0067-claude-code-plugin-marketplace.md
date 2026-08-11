# 0067 — Claude Code plugin and marketplace

- **Status:** done
- **Date:** 2026-08-11
- **PR:** https://github.com/vladar107/claudescope/pull/88

## Context

ClaudeScope already gives agents read-only access to transcript history through
`claudescope mcp`, but MCP registration is an extra setup step. The installed
CLI also exposes compact query commands (`search`, `sessions`, `session`,
`projects`, `analytics`, and `digest`), and those commands start the local
daemon on first use.

Claude Code plugins can distribute reusable skills through a marketplace. A
small skill can therefore teach Claude Code when and how to use ClaudeScope's
existing CLI without shipping another server, reading transcript files
directly, or changing the MCP integration. The plugin can be available
immediately from this repository's own marketplace and later submitted to
Anthropic's reviewed `claude-community` marketplace for broader discovery. See
the current [plugin guide](https://code.claude.com/docs/en/plugins) and
[marketplace guide](https://code.claude.com/docs/en/plugin-marketplaces).

## Goal

Ship a repository-owned `claudescope` Claude Code plugin whose `history` skill
can find prior solutions, inspect relevant session windows, list projects and
sessions, analyze usage, and produce work digests through the installed
ClaudeScope CLI. Make the same plugin installable from `vladar107/claudescope`
and ready for submission to the public Claude community marketplace.

## Decisions

- **Keep MCP and the skill as complementary entry points** — describe the skill
  as the zero-configuration Claude Code path; retain MCP as the structured,
  typed integration for MCP-capable clients.
- **Use the CLI as the only runtime dependency** — the skill invokes the
  existing read-only query commands and never reads `~/.claude`, `~/.codex`, or
  another agent source itself. It must not run lifecycle, update, pricing, or
  mutating HTTP commands.
- **Start with one model-invocable `history` skill** — one description covers
  prior-error search, decision retrieval, session inspection, analytics, and
  digests without adding several overlapping skills to every Claude context.
  The explicit invocation is `/claudescope:history`.
- **Keep output scoped and agent-oriented** — search and session listings use
  explicit limits; session reads use `--around` after a search hit or pageable
  windows, with best-effort `--redact` for follow-up session content. Search
  snippets are unredacted and enter the current Claude context, so searches
  stay minimal. Project listings and analytics can span the corpus; use them
  only when needed, filter session listings by project or agent, and scope
  analytics by date where relevant. Raw `--json` is reserved for cases where
  structured fields are actually needed, not used for ordinary session reading.
- **Host the plugin inside this repository** — place its self-contained files
  under `integrations/claude-code/` and point the root marketplace catalog at
  that directory. A Git marketplace source may clone the repository for its
  marketplace checkout; the installed plugin cache contains only the plugin
  directory.
- **Version the plugin independently** — set an explicit plugin version and
  bump it only when plugin content changes, so ordinary ClaudeScope commits do
  not look like plugin releases.
- **Use two distribution stages** — the self-hosted marketplace is the
  immediate, maintainer-controlled source; community-marketplace submission is
  a later external review step using the same plugin directory. Do not create a
  second plugin implementation or claim an Anthropic-official listing.

## Approach

1. **Plugin and catalog structure (simple; no prerequisites)** — add the root
   marketplace manifest and a self-contained plugin manifest under
   `integrations/claude-code/`, with product/repository metadata and an explicit
   initial plugin version.
   Acceptance: `claude plugin validate` accepts both the plugin and marketplace,
   and the catalog resolves only the intended integration directory.
2. **History skill behavior (complex; depends on 1)** — write concise trigger
   guidance and a command-selection workflow: confirm the `claudescope` binary
   exists, search first, inspect only the relevant session window, use project
   or agent filters when known, and choose analytics/digest only for aggregate
   questions. Include missing-install, empty-result, indexing, and command-error
   handling without inventing results.
   Acceptance: representative prompts select the correct CLI command, scope
   output where the CLI supports it, never mutate ClaudeScope or agent sources,
   and clearly tell the user how to install ClaudeScope when the binary is
   absent.
3. **Installation and product documentation (simple; depends on 1-2)** — add a
   plugin README with local-development and marketplace installation commands,
   then add a short Claude Code plugin section beside MCP and scripting in the
   main README. Explain the CLI prerequisite and the MCP-versus-skill tradeoff.
   Acceptance: a new user can add `vladar107/claudescope`, install
   `claudescope@claudescope`, reload plugins, and understand when the skill is
   expected to activate.
4. **Non-persistent validation and submission handoff (simple; depends on
   1-3)** — validate from a temporary plugin cache, load the plugin with
   `claude --plugin-dir`, exercise the representative prompts against synthetic
   or non-sensitive history, and prepare the exact community submission link
   and metadata. Submission itself remains a maintainer action after the
   repository PR is merged.
   Acceptance: plugin validation, invocation, automatic triggering, missing-CLI
   behavior, and self-hosted installation all work without modifying the
   maintainer's normal Claude plugin state.

## Files affected

- `.claude-plugin/marketplace.json` — repository marketplace catalog pointing
  to the ClaudeScope plugin.
- `integrations/claude-code/.claude-plugin/plugin.json` — plugin identity,
  version, attribution, and repository metadata.
- `integrations/claude-code/skills/history/SKILL.md` — model trigger and scoped,
  read-only CLI workflow.
- `integrations/claude-code/README.md` — self-contained installation, usage,
  privacy, and local-development guidance.
- `README.md` — user-facing Claude Code plugin installation and positioning.
- `docs/plans/0067-claude-code-plugin-marketplace.md` — this plan; keep its
  status and PR link current.
- `docs/plans/README.md` — plan index entry.

## Testing

1. Run `claude plugin validate ./integrations/claude-code` and validate the
   repository marketplace catalog with the current Claude Code CLI.
2. Load with `claude --plugin-dir ./integrations/claude-code`, then manually
   exercise: prior-error search, search-hit windowing, recent sessions, a dated
   digest, no matches, missing binary, and an index-still-building response.
3. Install from the local marketplace using a temporary plugin cache; confirm
   `/claudescope:history` appears and no path outside the plugin directory is
   required after caching.
4. Run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and
   a final review pass. Do not add automated tests unless the maintainer
   explicitly requests them.

## Risks / open questions

- A skill is instruction-driven and uses Claude Code's shell tool, so it cannot
  offer the same typed argument contract as MCP. Keep the MCP documentation and
  avoid presenting the skill as technically equivalent.
- The plugin depends on `claudescope` being installed and discoverable in the
  shell environment. The absent-binary path must be short and actionable.
- Search snippets are unredacted and enter the current Claude context. Keep
  searches minimal; use best-effort `session --redact` for follow-up windows
  when exact paths or secret-like values are unnecessary.
- Anthropic reviews community submissions and may request metadata or behavior
  changes. A community listing is an external outcome, not a condition for the
  self-hosted marketplace to ship.
- Marketplace and plugin schemas evolve with Claude Code. Recheck the current
  validator and submission requirements immediately before implementation and
  submission.
