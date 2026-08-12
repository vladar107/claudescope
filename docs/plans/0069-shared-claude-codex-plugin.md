# 0069 — Shared Claude Code and Codex plugin

- **Status:** done
- **Date:** 2026-08-12
- **PR:** <link, once opened>

## Context

ClaudeScope already ships a repository marketplace and a skills-only Claude
Code plugin under `integrations/claude-code/`. OpenAI now supports skills-only
plugins through a required `.codex-plugin/plugin.json` manifest, and Codex can
add Git-backed marketplaces whose catalog uses the existing legacy-compatible
`.claude-plugin/marketplace.json` location.

Creating a second history skill would let the Claude and Codex instructions
drift. The shared package also needs a product-neutral directory name whose
folder matches the stable `claudescope` plugin identifier required by the Codex
plugin tooling.

## Goal

Make the repository's existing `claudescope` plugin installable in both Claude
Code and Codex while preserving one `history` skill implementation and one
repository marketplace catalog.

## Decisions

- **Use one cross-product plugin root** — move the package to
  `plugins/claudescope/` and keep the Claude and Codex manifests side by side.
  The folder name then matches the plugin identifier, and neither product needs
  a copied skill.
- **Reuse the existing repository catalog** — retain
  `.claude-plugin/marketplace.json`, which Codex supports as a legacy-compatible
  repo marketplace, and update its source path to the shared plugin root. Do not
  add a duplicate `.agents/plugins/marketplace.json` catalog.
- **Keep the plugin skills-only** — continue invoking the installed,
  read-only `claudescope` query CLI. Do not bundle another MCP server or add
  hooks, apps, credentials, or lifecycle behavior.
- **Make shared instructions product-neutral** — refer to the current model or
  conversation context rather than Claude-specific context where the behavior
  is identical in both products.
- **Keep public publication separate** — this change prepares the package for
  OpenAI's universal ChatGPT/Codex directory, but submission and external review
  remain maintainer actions.

## Approach

1. Move the current Claude Code package into `plugins/claudescope/`, preserving
   its Claude manifest, README, and `history` skill.
2. Add a validated `.codex-plugin/plugin.json` with the same identity, version,
   CLI dependency, and shared `skills/` path.
3. Update the existing marketplace source and documentation with distinct
   Claude Code and Codex installation commands and product-neutral behavior.
4. Validate the Claude catalog/plugin and Codex manifest/skill, run the normal
   repository checks, and review the final diff for duplicated sources or
   unintended changes.

## Files affected

- `.claude-plugin/marketplace.json` — point the existing catalog at the shared
  plugin root.
- `plugins/claudescope/.claude-plugin/plugin.json` — preserve Claude Code
  metadata in the shared package.
- `plugins/claudescope/.codex-plugin/plugin.json` — add the required Codex
  package manifest and install-surface metadata.
- `plugins/claudescope/skills/history/SKILL.md` — keep the single shared,
  product-neutral history workflow.
- `plugins/claudescope/README.md` — document Claude Code and Codex installation,
  use, privacy, and local validation.
- `README.md` — expose both plugin installation paths to users.
- `docs/plans/0069-shared-claude-codex-plugin.md` — record the implementation.
- `docs/plans/README.md` — index this plan.
- `integrations/claude-code/` — removed after its files move to the shared root.

## Testing

1. Run the plugin-creator validators against `plugins/claudescope/` and its
   shared `history` skill.
2. Run `claude plugin validate . --strict` and
   `claude plugin validate ./plugins/claudescope --strict`.
3. Verify the marketplace and both manifests parse as JSON, all declared paths
   resolve inside the plugin root, and no duplicate `history` skill remains.
4. Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
5. Perform a final review pass over the complete diff.

## Risks / open questions

- Codex plugin and marketplace schemas may continue to evolve. Recheck current
  official OpenAI documentation before public submission.
- Existing Claude marketplace installs cache the old package path. The catalog
  remains the stable entry point, but users may need to refresh or reinstall the
  plugin after upgrading the marketplace checkout.
- OpenAI directory publication is a separate reviewed operation and is not
  implied by repository-local compatibility.
