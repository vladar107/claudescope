# 0088 — Skills inventory

- **Status:** done
- **Date:** 2026-09-17
- **PR:** <https://github.com/vladar107/claudescope/pull/115>

## Context

Every supported agent loads skills from `SKILL.md` directories, but each keeps
them somewhere else (`~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`,
`~/.config/opencode/skills`, the cross-agent `~/.agents/skills`, plugin caches),
often behind symlinks into a dotfiles repo, and nothing shows the whole picture:
what is installed where, which agents see the same install, and which skills
are actually used. Skill invocations are already indexed — `events.skill_names`
carries the `skill` argument of canonical `Skill` calls (plan 0079/0081) — so an
inventory can be joined with real usage instead of being a prettier `ls`.

The Memory area (`data/memory.ts`, `routes/memory.ts`, `pages/memory/`) is the
established shape for "read live from agent home dirs, never indexed, per-agent
cards with `supported: false` for agents that keep no store".

## Goal

A **Skills** area next to Memory: one card per detected agent with installed /
used / never-used counts, drilling into a per-agent table of every skill with
its origin (user dir, plugin, shared dir, bundled), resolved path, the other
agents that read the same install, and invocation figures where the agent's
format records them.

## Decisions

- **Same seam as memory** — an optional `skills?(): SkillEntry[]` hook on
  `AgentConnector`; connectors only list dirs and origins, the shared
  `connectors/skill-md.ts` walks, parses frontmatter and resolves symlinks.
  Rejected: indexing skills in DuckDB — they change out of band and are cheap
  to read.
- **Home dirs only** — agent home dirs plus `~/.agents/skills`; project-scoped
  skills (`.claude/skills`, `.agents/skills` in a repo) are out of scope for the
  same reason Junie's repo-local memory is: surfacing them means reading
  arbitrary project dirs.
- **Usage is a declared capability with two deterministic shapes** —
  `SKILL_INVOCATION_SIGNAL` in `data/agent-capabilities.ts`. A native call
  (Claude Code's `Skill`, Grok's and opencode's `skill` tool, Junie's
  `toolType: Skill` block) maps to the canonical `Skill` block; a read of
  `…/skills/<name>/SKILL.md` (how Codex, pi, Copilot and Antigravity load a
  skill — Codex's rollouts carry only a session-level
  `skills.includeInstructions` flag besides that read) names the skill from the
  path without inventing a call — the DIRECTORY name, so usage joins on the
  declared name and the directory name alike, and writes, delegations and
  fetches that merely mention the path are skipped. A read inside a plugin
  cache (`plugins/cache/<marketplace>/<plugin>/<version>/`) or a marketplace
  repo's `plugins/<plugin>/` source is named `plugin:dir`, and plugin
  inventories use the same form for every agent, so one plugin skill lines up
  across agents on the chart. A rule test walks the registry so a new
  connector must be classified; an unclassified format gets an absent `usage`,
  never a fabricated 0. Rejected: counting only native calls — that left five
  agents at "usage unavailable" while their transcripts plainly show the load.
- **Dedupe by `realPath`** — a symlinked dir or the shared dir is one install;
  each agent lists it with `visibleTo` naming the others. Counted per row with
  `toolCallRowsSql()` (fork copies excluded), never the usage election.
- **Used-but-unlocated** — a name the transcripts show invoked but installed
  nowhere the agent's hook reaches surfaces as such (project-scoped or removed).
- **One settings key** — `OPENCODE_CONFIG_DIR`, since `~/.config/opencode`
  cannot be derived from opencode's data dir. The cross-agent
  `~/.agents/skills` gets no setting: it is located beside each configured
  harness home (`~/.codex` → `~/.agents/skills`), so a sandboxed harness
  carries it along and the Settings page stays free of a local-setup knob.

## Approach

1. Shared types (`SkillsResponse` & co.), the connector hook, `skill-md.ts`,
   settings getters, capability sets.
2. Per-connector `skills.ts` for Claude Code (user dir + installed plugins,
   named `plugin:skill`), Codex (`skills`, `.system`, shared, plugin cache), Grok, pi
   (recursive + root files, shared), opencode (config `skills`/`skill`,
   Claude's dir, shared), Copilot, Antigravity, Junie (`skills` plus the
   bundled `versions/<newest build>/skills`).
3. `data/skills.ts` (collect, dedupe, usage join, overviews) and
   `GET /api/skills`.
4. Web: `/skills` landing cards and `/skills/:connectorId` table, nav entry.
5. Tests: registry rule test, rollup unit test, one integration test over a
   sandboxed skills tree and a synthetic session with a `Skill` call.

## Files affected

- `packages/shared/src/api.ts` — Skills section.
- `packages/server/src/connectors/{types,skill-md}.ts`, `connectors/*/skills.ts`.
- `packages/server/src/settings.ts` — `opencodeConfigDir`,
  `sharedSkillsDirBeside`, `piHome`, `grokHome`, `claudePluginsDir`.
- `packages/server/src/data/{agent-capabilities,skills}.ts`,
  `routes/{skills,index}.ts`.
- `packages/web/src/pages/skills/*`, `api/client.ts`, `App.tsx`.
- `packages/server/test/{connector-skill-signal,skills-overview,skills.integration}.test.ts`.
- `README.md`, `CLAUDE.md`, this plan.

## Testing

`npm test`, `npm run typecheck`; `/verify` against sandboxed fixtures for both
pages. The integration test covers the edges: symlinked dir resolves
`realPath`, a shared dir seen by two agents yields `visibleTo`, a `plugin:skill`
name joins usage, a used-but-uninstalled name lands in `unlocated`, a
frontmatter-less `SKILL.md` falls back to the dir name, and an agent without
the signal gets `usage` absent, not 0.

## Risks / open questions

- Claude Code `/name` slash invocations are user text, not `Skill` calls, so
  they are not counted; only tool-mediated loads are.
- A SKILL.md read counts as a load even when the agent re-reads it in chunks or
  opens it from a shell to edit it — an over-count stated in the per-agent
  usage note. pi's single-file `skills/<name>.md` layout has no SKILL.md to
  recognise, so those skills never count (also stated in the note).
- Grok plugin-shipped skills are not enumerated yet — follow-up. (Claude Code
  and Codex plugin skills are read from their plugin caches through the shared
  `connectors/plugin-skills.ts`: the default `skills/`, the manifest `skills`
  paths, `commands/*.md`, or a root `SKILL.md`.)
- No CLI/MCP surface yet (`claudescope skills`, `list_skills`) — follow-up.
- The Analytics "Skill usage" chart stacks calls by agent (badge legend,
  agent-colored segments) — landed here after review.
