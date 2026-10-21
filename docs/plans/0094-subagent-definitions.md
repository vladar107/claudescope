# 0094 — Subagent definitions on the Extensions page

- **Status:** done
- **Date:** 2026-10-21
- **PR:** <https://github.com/vladar107/claudescope/pull/125>

## Context

The Extensions page (plan 0093) lists what each agent loads from its home
dir — skills, MCP servers, hooks, plugins — and only skills carry usage.
Custom **subagent definitions** (`~/.claude/agents/*.md` and their
equivalents) are a fifth kind, configured just as scattered, and nothing shows
them. Unlike hooks, their usage is recoverable: every connector but Junie
already turns a spawn into a canonical `Task`/`Agent` tool_use carrying
`input.subagent_type`, so a subagent can get exactly what a skill gets.

Where each agent keeps them (user/global scope only):

| Agent | Definitions | Name | Spawn names it as |
|---|---|---|---|
| Claude Code | `~/.claude/agents/**/*.md`; plugin `agents/` (manifest `agents` = file list, replaces default) | frontmatter `name`; plugin: `plugin:<subdir:>name` | `Agent`/`Task` `subagent_type` |
| Codex | `~/.codex/agents/*.toml` (`name`, `description`, `developer_instructions`) | `name` | `spawn_agent` `agent_type` → `Task.subagent_type` |
| opencode | `~/.config/opencode/{agent,agents}/**/*.md`; `opencode.json(c)` `agent.<name>` | filename / key | `task` `subagent_type` (newer: `agent`) |
| Copilot | `~/.copilot/agents/*.agent.md` / `*.md` | filename stem (`name` = display) | `task` `agent_type` → `Task.subagent_type` |
| pi | `~/.pi/agent/agents/*.md` (subagent example extension) | frontmatter `name` | `subagent` `agent` / `tasks[].agent` / `chain[].agent` |
| Junie | `~/.junie/agents/*.md` | `name`, else filename | `spawn_subagent` — not in `events.jsonl` |
| Antigravity | `~/.gemini/config/agents/<name>.md` or `<name>/agent.md` | frontmatter `name` | `invoke_subagent` → `Task.subagent_type` (`TypeName`) |
| Grok | `~/.grok/agents/` (format undocumented) | — | `spawn_subagent` → `Task.subagent_type` |

## Goal

A **Subagents** kind on the Extensions page with the same information skills
have: on each agent card, `N subagents · used · never used · used but not
defined`; on the agent page, a Subagents tab listing name, description,
origin, plugin, source/real path, `visibleTo`, and calls / sessions / last
used, plus a "used but not defined globally" section.

## Decisions

- **Definitions read live, never indexed** — same as skills, via a new optional
  `subagents?()` connector hook returning `SubagentEntry[]`. Supported = the
  hook exists; Grok omits it until its format is documented (card says "not
  supported", never an invented empty list).
- **Usage via a new `events.subagent_names` column** (comma-joined, shaped like
  `skill_names`), derived from canonical `Task`/`Agent` tool_use
  `input.subagent_type`. Named `subagent_*` because "agent" here means the
  harness (`connector_id`). Schema v27 → one full reindex. Rejected: parsing
  `message` JSON at query time (slow, and normalizer-only inputs such as pi's
  `tasks[]` are gone by then).
- **One spawn = one count.** No per-row dedupe (unlike `skillNamesCsv`'s file
  reads): a pi batch of three tasks on one agent counts 3.
- **Usage is a declared signal** — `SUBAGENT_INVOCATION_SIGNAL` in
  `data/agent-capabilities.ts`, walked by a fitness test, exactly like
  `SKILL_INVOCATION_SIGNAL` (and separate from `NO_SUBAGENT_LINKAGE`). Junie
  is declared WITHOUT (its delegation is not in `events.jsonl`), so its
  definitions show "usage unavailable", never 0.
- **Two-key usage join.** Each agent's "invoked-as" name is a guess for at
  least one layout (Claude plugin namespacing, Copilot stem vs display name,
  opencode key vs file). `SubagentEntry` carries `name` plus `fileStem` (and,
  for plugin entries, the unprefixed name), and usage joins on all keys the
  way `usageFor` in `data/skills.ts` joins `name`/`dirName`. A wrong guess
  then costs nothing instead of "never used" everywhere. An alias that is
  another definition's name, or that two definitions share, counts for
  neither. Claude Code user agents get no alias: they are spawned by `name`
  alone, and files without one are documentation Claude Code skips.
- **No hardcoded built-ins.** `general-purpose`, `Explore`, `explorer`, … land
  in the unlocated bucket, titled "Used but not defined globally (built-in or
  project-level)". Built-in lists drift per release; a heading doesn't.
- **A spawn without a type records nothing** (`subagent_type` empty or absent
  — Claude Code's implicit `general-purpose`, Codex without `agent_type`).
  Inventing the default would bake one agent's convention into the column.
- **Primary-only agents are excluded** where the format says so (opencode
  `mode: primary`, Antigravity `subagent: false`); disabled ones
  (opencode `disable: true`) are skipped. Copilot's `user-invocable` agents
  stay — they are still spawnable.
- **Separate `data/subagents.ts` + `GET /api/subagents`**, mirroring
  `data/skills.ts` rather than generalising it, so skills stay untouched. It
  keeps the skills rules: dedupe by `realPath` into `visibleTo`; only an
  `origin !== 'shared'` entry is evidence the agent is installed; a throwing
  reader is caught and warned (`safeSkills` pattern), never blanks the page.
- **Global scope only** — never project dirs (`.claude/agents`,
  `.codex/agents`, …), matching the skills invariant; project agents show up
  in the unlocated bucket instead.
- **Out of scope, deliberately:** literal search over the column and an
  Analytics `kind=subagent` breakdown (both use `skill_names` today), plugin
  `contents.agents` counts.

## Approach

Wave 0 — contract (orchestrator):

1. `shared/src/api.ts`: `InstalledSubagent`, `UnlocatedSubagent`,
   `AgentSubagents`, `SubagentsConnectorOverview`, `SubagentsResponse` (reuse
   `SkillOrigin`, `SkillPlugin`, `SkillUsage`). `connectors/types.ts`:
   `SubagentEntry` + `subagents?()` hook. Web `api.subagents()`. Export
   `readManifests` from `plugin-skills.ts` (no third manifest-reader copy).

Wave 1 — parallel, no shared files:

2. **Index signal** (Complex — Jev said simple @0.72; overridden: the Claude
   Code SQL lateral, `doc_id`-last staging order, and per-agent spawn
   fixtures are bug-prone). Every place a new `events` column must appear:
   `db/schema.ts` DDL (before `doc_id`) + v27 note; `CANONICAL_COLUMNS`,
   `CanonicalRow` (required field) and `compactionRow` in `canonical.ts`; the
   staged SELECT in `data/index.ts:loadFile` (before `doc_id`); the Claude
   Code projection — a `BLOCK_AGG_LATERAL` aggregate mirroring the
   `skill_names` guard (`name IN ('Task','Agent')`, `json_type(...) =
   'VARCHAR'`, `<> ''`) plus a `SUBAGENT_NAMES_EXPR`. New
   `connectors/subagent-names.ts` `subagentNamesCsv` for canonical blocks;
   every normalizer sets the column — pi derives `tasks[]`/`chain[]` names
   inside `pi/normalize.ts`, opencode accepts `input.agent ??
   input.subagent_type`. Declare the signal + `connector-subagent-signal.test.ts`,
   reusing fixture builders from `copilot.integration.test.ts`,
   `grok.integration.test.ts`, `codex.integration.test.ts`,
   `nested-subagents.integration.test.ts` (Copilot needs a linked
   `subagent.started`; Grok needs `subagents/<id>/meta.json`; Antigravity fans
   out `Subagents[]`). *Accept:* each declared normalizer's one-spawn fixture
   names the agent; Junie's stays empty; `canonical-contract.test.ts`, tests
   and typecheck pass.
3. **Definition readers** (Complex, Jev 1.0) — new files only:
   `connectors/agent-md.ts` (frontmatter via `parseSkillFrontmatter`, name
   fallback to file stem, recursive with `:`-joined subdirs for plugins,
   `realPath`, mtime) and per-connector `connectors/<id>/subagents.ts`
   exporting a reader: Claude Code (user + plugins via
   `readInstalledPlugins`/`readManifests`, manifest `agents` file list
   replaces the default dir), Codex (`readTomlFile`), opencode (dirs +
   `opencode.json(c)` `agent` key, primary/disabled filtered), Copilot
   (`.agent.md` stripped first), pi, Junie, Antigravity (`<name>.md` and
   `<name>/agent.md`, `subagent:false` filtered). No wiring into
   `<id>/<id>.ts` (that is chunk 5). *Accept:* tests for the weird edges
   only — malformed/absent frontmatter, manifest override, nested plugin
   namespacing, primary/disabled filtering, `.agent.md` vs `.md` collision,
   symlinked dir realPath; nothing written to any source.
4. **Web** (Simple, Jev 0.86). Landing card gains a subagents line (third
   fetch merged into `CardData`, "usage unavailable" chip per kind); agent
   page gains a `subagents` tab copying the Skills tab (sortable usage
   columns, origin chip, `visibleTo`, unlocated section). *Accept:*
   typecheck; renders against a hand-written `SubagentsResponse` mock.

Wave 2:

5. **Data + route + wiring** (Complex, Jev 0.70). Wire `subagents:` into each
   `connectors/<id>/<id>.ts`; `data/subagents.ts` (collect with try/catch,
   dedupe, `loadSubagentUsage` over `subagent_names` via `toolCallRowsSql`,
   two-key join, rollup, ordering, detection rule) and `routes/subagents.ts`,
   registered in `routes/index.ts`. *Accept:* pure rollup test (usage absent
   when undeclared; unlocated only with signal; shared install →
   `visibleTo`; stem/unprefixed key hits) and an integration test over a
   synthetic index asserting a Claude Code `Agent` spawn shows up in
   `/api/subagents`; `architecture-rules.test.ts` green.

Wave 3 — orchestrator: `/verify` end to end with Playwright screenshots of
`/extensions` and `/extensions/claude-code?tab=subagents` (light + dark),
CLAUDE.md gotcha (one paragraph: hook + declared signal + no built-ins),
plan status, PR.

## Files affected

- `packages/shared/src/api.ts` — response types.
- `packages/server/src/connectors/types.ts` — `SubagentEntry`, hook.
- `packages/server/src/connectors/plugin-skills.ts` — export `readManifests`.
- `packages/server/src/db/schema.ts`, `connectors/canonical.ts`,
  `data/index.ts` — `subagent_names` column, v27.
- `packages/server/src/connectors/subagent-names.ts` (new),
  `claude-code/claude-code.ts`, every `connectors/*/normalize.ts` — usage.
- `packages/server/src/connectors/agent-md.ts` (new),
  `connectors/*/subagents.ts` (new), each `connectors/<id>/<id>.ts` —
  definitions.
- `packages/server/src/data/agent-capabilities.ts` — signal declaration + notes.
- `packages/server/src/data/subagents.ts`, `routes/subagents.ts` (new),
  `routes/index.ts`.
- `packages/web/src/api/client.ts`, `pages/extensions/ExtensionsPage.tsx`,
  `AgentExtensionsPage.tsx`, `extensions.css`.
- `packages/server/test/` — signal fitness test, reader edge tests, rollup +
  integration tests.

## Testing

`npm test`, `npm run typecheck`, `/verify` against sandboxed fixtures (never
real agent dirs), Playwright screenshots of both pages.

## Risks / open questions

- **Full reindex** on upgrade (schema v27) — minutes on a large index.
- **Doc-only formats**: Codex, Copilot, pi, Antigravity have no local example;
  readers follow the docs and degrade to nothing on mismatch.
- **Antigravity `TypeName`** may not equal the definition's `name`; if it
  doesn't, usage lands in the unlocated bucket (wrong bucket, not a wrong
  number).
- **Junie's `~/.agents/`** — docs list it as a user location but the layout
  inside it is unclear (it also holds `skills/`); left out until confirmed.
- **Grok** reads Claude Code agents per its docs; not modelled until its own
  format is documented.
