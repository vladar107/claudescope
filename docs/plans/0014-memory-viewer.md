# 0014 — Memory viewer (instruction files + per-agent memory)

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-15 (revised 2026-06-15 after source- and disk-grounded research; see "Research basis")
- **PR:** https://github.com/vladar107/claudescope/pull/17

## Context

Coding agents persist long-lived "memory" on disk, separate from the transcripts
Claudescope indexes, and it's invisible unless you go spelunking in dotfiles or
the repo. The first cut of this plan assumed only Claude had per-project memory;
**source- and disk-grounded research (24 adversarial verdicts) showed all three
supported agents have a real memory subsystem.** There are two provenances:

- **User-authored instruction files** — what *you* tell the agent, globally:
  `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.junie/AGENTS.md`.
- **Agent-authored memory** — what the agent *distilled on its own*:
  - **Claude Code** — `~/.claude/projects/<slug>/memory/`: a `MEMORY.md` index + one
    `.md` file per fact with frontmatter (`name`, `description`, `type`,
    `originSessionId`). Written by **model-initiated `Write`/`Edit`** mid-session
    (the harness injects `node_type`/`originSessionId`); GA, default-on. 6 of 14
    local projects have one (23 fact files).
  - **Junie** — **repo-local** `<project>/.junie/memory/`: `tasks.md`, `errors.md`,
    `feedback.md`, `language.json`, `memory.version`. Written by automatic LLM
    "reflection" (user-feedback / error→rule / trajectory), flushed on close.
    Gated/experimental — present as empty scaffolds on this machine (verified:
    `~/src/transript-viewer/.junie/memory/`, gitignored).
  - **Codex** — a **global** store: `~/.codex/memories/` (git-baselined markdown:
    `MEMORY.md` handbook, `memory_summary.md`) + `memories_1.sqlite`
    (`stage1_outputs`). Written by an automatic background two-phase job at session
    start (distills *other* recent rollouts idle ≥6h). Experimental, off by
    default, geo-gated → empty for essentially everyone (0 rows here).

The unlock specific to *this* product remains Claude's `originSessionId`: every
fact deep-links to the transcript that produced it — a cross-link only a viewer
that already indexes those sessions can offer.

**Scope decision (after research):** v1 covers all three agents' **global
instruction files** plus **Claude's and Codex's agent-authored memory** (Codex
best-effort / graceful-empty). **Junie's per-project `.junie/memory/` is OUT of
scope** — it lives *inside each repo*, so surfacing it would force Claudescope to
read arbitrary user project directories, breaking the invariant that it reads only
from the agent home dirs (`~/.claude`, `~/.codex`, `~/.junie`). Junie still
contributes its global `~/.junie/AGENTS.md`. User-authored *repo-level* `CLAUDE.md`
/ root `AGENTS.md` likewise stay deferred (same reason — they're in the repo).

## Research basis

Findings the build depends on, each verified against source code *and* disk:

- **Claude memory is NOT the Anthropic server-side memory tool** (refuted). It's
  model-initiated `Write`/`Edit` to the `memory/` path; the connector must read the
  directory directly (writes aren't reconstructable from transcript tool replay).
- **Claude has two coexisting frontmatter layouts:** nested
  (`metadata:{node_type, type, originSessionId}`, since ~2026-05-13) and flat/legacy
  (top-level `name/description/type/originSessionId`, oldest two lack
  `originSessionId`). Parse both.
- **Claude `type` enum = exactly `user | feedback | project | reference`** (from the
  binary). `originSessionId` is a clean FK to `<slug>/<originSessionId>.jsonl`.
- **Claude slug is keyed by the git repo root** (`git rev-parse --git-common-dir`),
  not raw cwd — worktrees/subdirs of one repo share one memory dir. Claudescope
  buckets transcripts by raw cwd, so memory keying can diverge from project keying.
- **Codex memory is real but experimental/off-by-default/geo-gated** and a **global**
  store (no cwd column; cwd needs `stage1_outputs.thread_id → state_5.sqlite
  threads.cwd`). DB files are **version-suffixed** (`memories_1`, `state_5`).
- **Junie memory is repo-local** (`<cwd>/.junie/memory/`), plain MD/JSON, distinct
  from `~/.junie/AGENTS.md`.
- **No agent has a built-in `/remember` that writes its memory store.** The local
  `~/.junie/commands/remember.md` and `~/.claude/.../remember` skill are the user's
  own Claude skill (imported into Junie via `/import`); both target a `CLAUDE.md`.
  Do not surface `/remember` artifacts as agent memory.

## Goal

A read-only **Memory** area that surfaces, for every connector: its global
user-authored instruction file(s) **and** its (home-dir-resident) agent-authored
memory — Claude's typed facts (with `[[wiki-link]]` resolution and an "origin →"
deep-link to the session that produced each) and Codex's global handbook
(best-effort). Reachable as a **top-level page** (global-first, cross-project) and
a **per-project Memory tab**. Every store is usually empty/absent — "no memory" is
a normal, first-class state, never an error.

## Decisions

- **Read only from agent home dirs; never read user project directories** — the
  whole tool's read surface stays `~/.claude` / `~/.codex` / `~/.junie` (+ their env
  overrides). This is the load-bearing constraint: it's *why* Junie's repo-local
  `.junie/memory/` is excluded, and *why* Claude attribution must not shell out to
  `git` inside a project (see below).
- **Read live, not indexed** — files are tiny and change between sessions; reading
  on request keeps them never-stale and out of the rebuildable DuckDB cache.
- **Memory is a connector capability** — `globalMemory()` and `projectMemory(cwd)`
  on the `AgentConnector` port (TS methods like `loadSession`, not SQL projections).
  Each returns a list of `MemorySource` (a flexible shape covering typed facts,
  category documents, and handbook blobs), tagged `provenance:
  'user-authored' | 'agent-authored'`. Keeps "add an agent = add a connector" intact.
- **`MemorySource` over a rigid `MemoryFact`** — the three stores differ structurally
  (Claude = per-fact-with-frontmatter; Junie = fixed category files; Codex =
  markdown handbook). One union shape with `kind: 'fact' | 'document'` fits all and
  keeps the API/UI uniform.
- **Graceful-empty everywhere** — absent dir / 0 rows / empty scaffold all render as
  "no memory for this agent," never an error. (Critical: this is the common case.)
- **Claude project attribution stays home-dir-only** — for `projectMemory(cwd)`,
  dash-encode the cwd to the candidate slug and read `~/.claude/projects/<slug>/memory/`
  (pure string transform; no `git` call into the project dir). For the top-level page,
  attach each fact to the project of its `originSessionId` (Claudescope already maps
  sessions→projects), which also absorbs the git-root/worktree divergence. Tolerate
  dangling refs. Worktree-keyed dirs that the dash-encode misses are an accepted v1
  gap (open question), **not** a reason to run git in user repos.
- **Codex: markdown-first, SQLite-second** — read `~/.codex/memories/MEMORY.md` +
  `memory_summary.md` (stable, human-readable) as a global agent-memory doc; the
  `memories_*.sqlite` + `state_*.sqlite` cwd-join is a secondary/per-project path
  (deferred attribution — open question). **Glob `*_<N>.sqlite` and pick the highest**;
  never hardcode the suffix. Open SQLite read-only (copy-to-tmp to dodge WAL).
- **Hand-parse frontmatter, no new dependency** — server runtime deps stay
  `@duckdb/node-api` + `fastify`. A ~20-line parser handles both Claude layouts;
  Junie/Codex are plain markdown/JSON.
- **Global memory rendered verbatim** — do not resolve Claude `@path` imports in v1.
- **Separate provenance in the UI** — user-authored instruction files visually
  distinct from agent-distilled memory; imported `commands/skills` are labelled user
  artifacts, surfaced by file path, never as agent memory.

## Per-agent storage reference

| Agent | Global (user-authored) | Agent-authored memory | Format | cwd key |
| --- | --- | --- | --- | --- |
| Claude | `~/.claude/CLAUDE.md` | `~/.claude/projects/<git-root-slug>/memory/*.md` | MD + frontmatter (2 layouts) | git repo root; per-fact via `originSessionId` |
| Junie | `~/.junie/AGENTS.md` | — *(out of scope: repo-local `.junie/memory/` would require reading all project dirs)* | MD | — |
| Codex | `~/.codex/AGENTS.md` | `~/.codex/memories/MEMORY.md`, `memory_summary.md`; `memories_*.sqlite` `stage1_outputs` | MD; SQLite | **global** (cwd via `state_*.sqlite threads.cwd` join) |

## Approach

1. **Shared types** (`packages/shared/src/api.ts`): `MemorySource`
   (`provenance`, `kind`, `title`, `category?`, `markdown`, `sourcePath`,
   `updatedAt`, `originSessionId?`, `relatedNames?`, `empty?`), `GlobalMemory`
   (per connector: label + `MemorySource[]`), `ProjectMemory` (per connector:
   `MemorySource[]` + optional `indexMarkdown`), and the two response bodies.
2. **Connector port** (`connectors/types.ts`): optional
   `globalMemory(): MemorySource[]` and `projectMemory(cwd): MemorySource[]`.
3. **Claude connector**: `globalMemory` → `~/.claude/CLAUDE.md` (user-authored).
   `projectMemory(cwd)` → dash-encode cwd → slug → read `memory/*.md` (skip the
   redundant `MEMORY.md` index), hand-parse **both** frontmatter layouts, extract
   `[[name]]` → `relatedNames`, carry `originSessionId`, `updatedAt` from mtime,
   `provenance: 'agent-authored'`. `[]` if absent.
4. **Junie connector**: `globalMemory` → `~/.junie/AGENTS.md` (user-authored) only.
   **No `projectMemory`** — its store is repo-local and out of scope per the
   home-dir-only invariant.
5. **Codex connector**: `globalMemory` → `~/.codex/AGENTS.md` (user-authored) **plus**
   best-effort `~/.codex/memories/MEMORY.md` + `memory_summary.md` (agent-authored,
   global). `projectMemory` → `[]` in v1 (per-project Codex attribution deferred).
   All paths optional/graceful-empty; glob versioned DBs only if/when SQLite path lands.
6. **Server route** (`routes/memory.ts`, registered in `routes/index.ts`):
   - `GET /api/memory` → `{ global: GlobalMemory[], projects: ProjectMemorySummary[] }`
     (every connector's global sources + projects that have any agent memory, with
     per-agent counts).
   - `GET /api/projects/:projectId/memory` → `{ byAgent: { connectorId, label,
     sources }[] }` — resolve the project's cwd, ask each connector.
7. **Web — top-level page** (`pages/memory/MemoryPage.tsx`): instruction-file cards
   (one per agent) clearly separated from agent-memory; then projects-with-memory,
   expanding fetches the per-project endpoint. Add `Memory` to `NAV_ITEMS` + `/memory`.
8. **Web — project tab**: Sessions | Memory tabs on `/projects/:projectId`; reuse the
   memory components.
9. **Web — rendering**: a `MemorySource` renderer — provenance/category chip,
   markdown body, `[[name]]` → in-page anchors (unmatched → plain text), and
   "origin →" to `/sessions/<originSessionId>` when present and indexed.
10. **API client** (`web/src/api/client.ts`): `memory()` + `projectMemory(id)`.

## Files affected

- `packages/shared/src/api.ts` — memory types + response bodies.
- `packages/server/src/connectors/types.ts` — optional memory methods.
- `packages/server/src/connectors/claude-code/` — facts + git-root slug + dual
  frontmatter parse (likely a `memory.ts` helper).
- `packages/server/src/connectors/junie/` — `globalMemory` (`~/.junie/AGENTS.md`) only.
- `packages/server/src/connectors/codex/` — AGENTS.md + best-effort `memories/` MD.
- `packages/server/src/routes/memory.ts` (new) + `routes/index.ts`.
- `packages/web/src/App.tsx` — nav item, `/memory` route, project tabs.
- `packages/web/src/pages/memory/MemoryPage.tsx` (new) + `MemorySource` component.
- `packages/web/src/pages/browse/SessionList.tsx` — project view tabs.
- `packages/web/src/api/client.ts` — client methods.

## Testing

- `npm run typecheck` + `npm test`.
- Temp-dir fixtures (never touch real `~/.claude`/`~/.codex`/`~/.junie`):
  - Claude: a `memory/` with **both** frontmatter layouts, a `[[link]]`, a fact
    with and without `originSessionId` (incl. a dangling one) → assert parsed sources;
    missing dir → `[]`.
  - Junie: global `~/.junie/AGENTS.md` present/absent → assert the doc / graceful-empty.
  - Codex: a `~/.codex/memories/MEMORY.md` present and absent → assert graceful-empty.
  - A worktree fixture (cwd under a linked worktree) → assert Claude memory still
    attributes to the right project via `originSessionId`.
- Manual: open Memory — three instruction cards render; the 6 Claude projects show
  facts; wiki-links jump; "origin →" lands on the right session (degrades when the
  session isn't indexed); Junie/Codex show "no memory" cleanly when empty.

## Risks / open questions

- **Claude slug ≠ Claudescope project key** (git-root vs raw cwd) — handle worktrees
  via `originSessionId` attribution; cross-check the slug-derivation fallback.
- **Codex markdown block format is source-described, unobserved live** — the
  `cwd=/rollout_path=/thread_id=` block convention in `MEMORY.md` has never been seen
  populated; validate against a real opted-in user before relying on it for
  per-project Codex attribution.
- **Versioned SQLite filenames** (`memories_N`, `state_N`) will bump — always glob.
- **Junie memory schema is v1.0 scaffold; binary expects v3.0** — the *populated*
  body shape of `tasks/errors/feedback.md` and the v3 `language.json` are unknown;
  parse defensively, render raw markdown.
- **Claude lifecycle unknowns** — does an in-place rewrite keep the first
  `originSessionId` or adopt the editor's? Are deleted facts tombstoned? Is
  `MEMORY.md` auto-reconciled? Affects "when"/orphan detection.
- **Claude `scope: private|team` and unobserved `user`/`reference` types** — defined
  in the binary but not seen on disk; parser should tolerate a `scope` key and all
  four types.
- **Markdown safety** — reuse the hardened `Markdown` component; `[[name]]` rewrites
  to internal anchors only, never arbitrary URLs.
