# Claudescope — agent guide

A local, **read-only**, **multi-agent** viewer to browse, read, search, and
analyze AI coding-agent transcripts in one place — [Claude Code](https://claude.com/claude-code) (`~/.claude/projects/**/*.jsonl`),
[OpenAI Codex](https://openai.com/codex)
(`~/.codex/sessions/**/rollout-*.jsonl`),
[JetBrains Junie](https://www.jetbrains.com/junie/)
(`~/.junie/sessions/session-*/events.jsonl`), [pi](https://pi.dev)
(`~/.pi/agent/sessions/**/*.jsonl`), [opencode](https://opencode.ai)
(`~/.local/share/opencode/opencode.db`, SQLite),
[GitHub Copilot CLI](https://github.com/features/copilot)
(`~/.copilot/session-state/**/events.jsonl`), and
[Google Antigravity](https://antigravity.google)
(`~/.gemini/antigravity-cli/**/transcript_full.jsonl`, plus the desktop app dir
`~/.gemini/antigravity/`), and [xAI Grok CLI](https://x.ai)
(`~/.grok/sessions/**/chat_history.jsonl`). Sessions are merged by working
directory into one project per `cwd`, each session tagged with its agent.
Distributed as a single npm CLI (`@vladar107/claudescope`). This file is the
source of truth for both humans and agents working in this repo; `AGENTS.md`
points here.

## Architecture

npm-workspaces monorepo (`packages/*`):

| Package           | Role                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `packages/shared` | TypeScript types — the API + data contract shared by server and web.   |
| `packages/server` | Fastify API + DuckDB index (`@duckdb/node-api`); serves the built UI.  |
| `packages/web`    | Vite + React UI (react-markdown, Shiki, Recharts).                     |

- The server serves **both** the API and the built SPA on **one port** (`4317`).
- DuckDB reads the JSONL natively (`read_ndjson`) for indexing, full-text search,
  and analytics. A TS parser assembles the threaded view for a single session.
- **Agent connectors** (`packages/server/src/connectors/`) abstract each source.
  Claude Code projects per-row; Codex spreads a session across record types, so
  its connector normalizes a rollout to canonical NDJSON first (`codex/normalize.ts`).
  Adding an agent = adding a connector; the index/FTS/cost paths stay shared.
- The DuckDB index is a **derived cache** — fully rebuildable from the JSONL. If
  it's corrupt the app discards and rebuilds it.
- **One DuckDB connection is shared by the indexer AND every HTTP route**
  (`getConnection()` is a singleton). So indexer work must **never** open an
  explicit transaction: a `BEGIN` there encloses whatever queries the routes
  issue concurrently and aborts them along with a failed load. `loadFile`
  therefore gets its atomicity by staging instead (see Gotchas).

## Runtime state — critical

- **NEVER write to any agent source** (`~/.claude`, `~/.codex`, `~/.junie`,
  `~/.pi`, `~/.copilot`, `~/.gemini`, `~/.grok`, opencode's `opencode.db`). They are read-only data sources — and that
  includes reading agent memory live from those home dirs.
- All app-owned state lives in **`~/.claudescope/`** (override: `CLAUDESCOPE_HOME`):
  the DuckDB index, a user-editable `pricing.json` (seeded from a shipped
  default; `loadPricing` falls back to the default if the copy is missing),
  `pricing.fetched.json` (runtime-fetched rates snapshot, auto-refreshed daily
  from LiteLLM, or manually via `claudescope pricing update`), `settings.json`
  (written by the web UI's Settings page; **env vars always win** over saved
  values — resolution is env > file > default, per call via `settings.ts`
  getters, so source dirs and the reindex interval apply live without a
  restart), the daemon PID file, and logs. State lives outside the package dir
  so global installs survive upgrades — do not move it back into the package.
- App-owned state is created **owner-only** — always via `ensureStateDir()` from
  `config.ts`, never a bare `mkdirSync`. Every file writer passes
  `STATE_FILE_MODE`, and the server sets `umask 0077` at boot for the files
  DuckDB creates itself.
- The normalize cache (`cache/<agent>/*.ndjson`, written by `prepare()`) holds
  transcript text **verbatim**, so it is pruned every pass once its source file is
  gone — `ndjsonCache` owns the layout and `pruneNdjsonCaches` the sweep. A
  connector whose `discover()` threw is excluded, exactly as its indexed sessions
  are: the absence is transient, not a deletion.
- The web Settings page's Start/Stop/Restart control the **indexer** (the
  reindex poller — `indexer-lifecycle.ts`), never the HTTP process; stopping
  the server stays terminal-only (`claudescope stop`). The pause flag is
  runtime-only (not persisted).

## Commands

```bash
npm install         # install workspace deps
npm run dev         # server (watch) on :4317 + Vite dev server on :5317 (HMR)
npm start           # build (first run) + serve in the foreground
npm run build       # production build (shared → web → server)
npm test            # Vitest (run once)   |  npm run test:watch
npm run typecheck   # tsc -b across all packages
npm run bundle      # assemble the single publishable package into dist/
```

The shipped CLI (after install) is `claudescope {start|stop|status|restart|logs|open|update|pricing update}`,
plus read-only query subcommands (`search|sessions|session|projects|analytics|digest`, `--json` for scripts)
and `claudescope mcp` — a stdio MCP server that proxies the daemon (agents query their own history).

## Distribution model

`npm run bundle` (`scripts/bundle.mjs`) produces the published artifact in
`dist/`: esbuild bundles the server + CLI (shared lib inlined) into two minified,
source-map-free files; the web build, a default `pricing.json`, and `README.md`
are copied alongside; a self-contained `package.json` is generated whose only
runtime dependency is the native `@duckdb/node-api`. The **version is injected at
bundle time** via esbuild `define` (`__CLAUDESCOPE_VERSION__`) — never hardcode
it. Publish metadata (keywords, repo, etc.) is sourced from the **root**
`package.json`; edit it there, not in `bundle.mjs`.

**Other channels wrap this npm package** — no separate artifacts. **Homebrew**
(formula in the separate `vladar107/homebrew-tap` repo) and a **Nix flake**
(`flake.nix` at the repo root, builds from source via `buildNpmPackage`) both
install `@vladar107/claudescope` under the hood and let npm/Nix resolve the native
`@duckdb/node-api` binary. `release.yml` runs as independent jobs (validate →
create release → npm ∥ nix, then brew after npm): it bumps the Homebrew formula
(needs the `HOMEBREW_TAP_TOKEN` secret) and verifies the flake builds. A failure
in one channel doesn't block the others. The flake feeds `fetch-npm-deps` a
version-neutralized `package-lock.json` (`depsLock` in `flake.nix`), so its
dependency hash is version-independent: releases need no Nix and no hash step, and
the hash only changes when dependencies actually change (caught by the CI `nix`
job).
The CLI `update` command (`cli.ts`) detects the install method and defers to
`brew`/`nix` instead of `npm install -g` for those installs. See `CONTRIBUTING.md`.

## Conventions

- **Code style:** match the surrounding code — TypeScript, ESM, existing naming
  and comment density. Moderate doc comments on functions/complex logic.
- **Don't touch unrelated code.** No drive-by refactors or "improvements."
- **Tests:** run `npm test` and `npm run typecheck` after changes. Add tests only
  when the logic warrants it (the integration suite builds a real DuckDB index
  from synthetic fixtures in a temp dir — never touches any real agent source).
  **Keep tests focused on the weird stuff** — the hard, bug-prone domain edges,
  not happy-path glue: malformed/truncated JSONL, subagent correlation, cost
  dedup-by-`message.id`, stale-cache / index-corruption recovery, pricing refresh
  and fallback, connector normalization quirks. Don't pad coverage with trivial
  cases that can't realistically fail.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). **Do not add AI
  co-author / "Generated with" trailers** — keep history clean and human-authored.
- **Branches:** use conventional purpose prefixes (`feat/`, `fix/`, `chore/`,
  etc.); never use generic agent-identity prefixes such as `agent/`.
- **Linear history:** rebase onto `main`; no merge commits. PRs land via
  fast-forward / rebase / squash.
- **Plans:** when an agent does non-trivial work, **save the plan directly into
  the repo** as `docs/plans/NNNN-kebab-title.md` (next sequential number) from
  [`TEMPLATE.md`](./docs/plans/TEMPLATE.md), set its `Status`, add a row to the
  index table, and link it in the PR. If you planned via `/plan` (plan mode), the
  plan was written to **ephemeral** storage outside the repo (e.g.
  `~/.claude/plans/<name>.md`) — check there and copy it in, otherwise it's lost.
  See `docs/plans/README.md`.

## Gotchas

- **Thinking blocks render empty** — Claude Code stores only a signature (and
  Codex only encrypted reasoning), not the plaintext. Expected, not a bug.
  **pi, Antigravity, and Grok are the exceptions**: pi and Antigravity store
  plaintext thinking (pi also keeps an opaque `thinkingSignature`), and Grok
  stores plaintext reasoning *summaries* next to its encrypted content, so
  their reasoning renders in full.
- **Codex sessions have no stored title** — the session title falls back to the
  first user message (see `first_user` in `data/index.ts`). Same for **pi**.
- **Codex subagents & apply_patch** — subagent rollouts are separate files whose
  `session_meta` carries `thread_source: "subagent"` + the parent thread id; they
  re-key under their ROOT thread (`is_sidechain`) and nest via a canonical `Task`
  synthesized from the parent's `spawn_agent` call. Legacy output links by
  `agent_id`; current output links `task_name` to the child's
  `thread_spawn.agent_path`, retaining the exact spawning call id. Prefer that
  readable task name over the possibly opaque prompt for the `Task` label.
  `function_call_output` / `custom_tool_call_output` may carry either one string
  or an ordered text-item array; decode the latter before envelope/error parsing
  and keep unknown structured items visible. Direct `apply_patch` calls arrive as
  `custom_tool_call` records (NOT `function_call`); current Codex may instead
  wrap one static `tools.apply_patch` call in the JavaScript `exec` custom tool.
  Both forms parse V4A envelopes and fan out to canonical `Write`/`MultiEdit`
  per file. Dynamic/ambiguous wrappers stay raw, and rejected or unconfirmed
  patches demote back to raw calls so Files changed never reports edits that did
  not happen.
- **Claude Code subagent correlation** — prefer direct connector linkage when
  available, then metadata-backed description/type matching. If sibling metadata
  is absent or drifted, the shared parser may fall back to an exact full match
  between the spawning `Agent`/`Task.prompt` and the child's first user prompt.
  Empty or ambiguous matches stay detached; there is no fuzzy prompt matching.
- **Nested subagents (a subagent spawning a subagent)** — the grandchild is a
  SIBLING file in the same `subagents/` dir, not nested a level deeper; its
  meta carries `toolUseId` (the `Agent` call inside its parent's transcript)
  and `parentAgentId`. `SubagentRun`s stay a flat list with a `parentAgentId`
  pointer, not a tree; spawn points are collected from every run's thread
  (plus the main thread), so a call living inside a run can still be matched.
  Description/prompt matching is scoped to the named parent's own spawns, or —
  without a parent — to the main thread only, never another run, so a
  same-named call elsewhere can't steal the match. A window carries a run's
  descendants along with it. pi and Grok still only re-key one hop, so their
  grandchildren surface as their own top-level sessions (follow-up).
- **pi connector** (`connectors/pi/`) — JSONL like Claude/Codex but `cwd` is on
  the `session` line and tool results are separate `toolResult` records, so a
  `prepare()` pass normalizes to canonical NDJSON (Codex pattern). `model` comes
  per-turn from the assistant message (the `model_change` records are ignored for
  attribution); the `uuid`/`parentUuid` chain is synthesized over message rows
  because pi's native chain threads through `model_change`/`thinking_level_change`
  records. pi has no home-dir memory, so the connector implements no memory.
  Subagent runs live at `<sessionBase>/<runId>/run-N/session.jsonl` (linkage:
  the `subagent` toolResult's `details.runId`); they re-key to the parent by
  path shape and nest via a canonical `Task` (management calls stay passthrough).
- **opencode connector** (`connectors/opencode/`) — the only **SQLite-backed**
  source: one `opencode.db` (`session`/`message`/`part`), read read-only via
  `node:sqlite` (built into Node 24 — no dep). Each session is a synthetic
  `DiscoveredFile` (`<dbPath>#<id>`); `prepare()` extracts it to canonical NDJSON
  (Codex pattern). File edits arrive via **`apply_patch`** (`state.metadata.files[]`
  per-file unified diffs) → mapped to canonical `Write`/`Edit`/`MultiEdit` so the
  Files-changed tab works; `read`→`Read`, `bash`→`Bash`, others passthrough; a
  pasted screenshot is a `file` part (data-URL) → `ImageBlock`. Reasoning is
  plaintext. Tokens are per-message (reasoning folded into output). `discover()`
  throws on a present-but-unreadable DB (the indexer isolates a throwing connector
  and preserves its sessions — it never wipes them). No memory. Task-spawned
  child sessions carry `session.parent_id` → re-keyed to the root ancestor
  (`is_sidechain`, cycle-guarded) and nested via the parent's `task` tool part
  (its `state.metadata.sessionId` names the child).
- **GitHub Copilot CLI connector** (`connectors/copilot/`) — event-sourced
  `~/.copilot/session-state/<uuid>/events.jsonl` (Junie/pi-shaped lines of
  `{type, data, id, timestamp, parentId}`); `prepare()` normalizes to canonical
  NDJSON. `cwd`/branch from `session.start`, model from `assistant.message`, title
  from the sibling `workspace.yaml` (`name`). **Tokens live ONLY in
  `session.shutdown`** (session-level; there is no per-message usage) → attached to
  the last assistant row, so a crashed/running session (no shutdown) costs zero.
  Reasoning is encrypted (`reasoningOpaque`) → empty thinking (Codex-style).
  `edit`/`create`→`Edit`/`Write` **only when the call succeeded** (a denied/failed
  edit passes through under its raw name, so it never reaches the Files-changed
  tab); `view`→`Read`, `bash`→`Bash`. Screenshots resolve from
  `session-state/<uuid>/files/<displayName>` (screenshot-saving must be on) → base64
  `ImageBlock`, else the inline `[📷 …]` marker remains. Global memory is
  `~/.copilot/copilot-instructions.md`; "session-level memory" is session-scoped
  (per-session `session.db` + `files/`), not cross-session, so no project memory.
  Subagents are INLINE in the parent's `events.jsonl`: inner events carry an
  event-level `agentId` (= the spawning `task` toolCallId) and are segmented into
  per-agent streams (`is_sidechain`), nested via a canonical `Task`; the
  `subagent.started` record supplies agent name/model.
- **Google Antigravity connector** (`connectors/antigravity/`) — an event stream
  but **with** assistant prose and plaintext thinking (unlike Junie). Read
  `~/.gemini/antigravity-cli/brain/**/transcript_full.jsonl` (also scans the
  desktop app dir `~/.gemini/antigravity/`); overrides `ANTIGRAVITY_CLI_DIR` /
  `ANTIGRAVITY_DIR`. `transcript_full.jsonl` is authoritative — **ignore the buggy
  `transcript.jsonl`**. `cwd` is resolved out-of-band from
  `~/.gemini/<surface>/history.jsonl` (fallback the `(unknown — Antigravity)`
  project bucket). Tool results are separate typed records (`VIEW_FILE` /
  `LIST_DIRECTORY` / `CODE_ACTION`) correlated by order. Subagents are separate
  conversations linked by `SYSTEM_MESSAGE sender=<id>`, re-parented under the root
  session (`is_sidechain`) and nested via a canonical `Task` tool_use. **No token
  counts** in the transcripts (the per-conversation SQLite is opaque protobuf,
  ignored) → cost 0, tokens unavailable by design.
- **xAI Grok CLI connector** (`connectors/grok/`) — a session is a DIRECTORY
  (`~/.grok/sessions/<encoded-cwd>/<uuid>/`) spreading facts across three files:
  `chat_history.jsonl` is the message spine (OpenAI-Responses style; no
  timestamps/usage), `updates.jsonl` is a best-effort overlay carrying
  timestamps and the ONLY token usage (`turn_completed`, once per user turn —
  a missing/truncated updates file → summary-time timestamps and zero usage),
  and `summary.json` carries `cwd`/`generated_title`. `prepare()` normalizes to
  canonical NDJSON (pi pattern); discovery stats fold all three files so
  late-written usage/titles trigger re-index. Grok's `cachedReadTokens` is a
  SUBSET of `inputTokens` → split out at normalize time (`input − cachedRead`).
  Real user prompts carry `prompt_index` (text wrapped in `<user_query>`,
  stripped); user rows WITHOUT it are injected context (user_info/agents-md)
  and are skipped. `write`/`search_replace` map to canonical `Write`/`Edit` so
  the Files-changed tab works; images are inline data-URLs → `ImageBlock`.
  Subagents are SIBLING session dirs (child `summary.json` has
  `session_kind:"subagent"`, no parent pointer); the linkage lives only in the
  parent's `subagents/<child-id>/meta.json` — children re-key to the parent
  (`is_sidechain`) and nest via `spawn_subagent` → canonical `Task` (its
  `subagent_type` comes from meta, matched by the shared `description`).
  Experimental memory (`~/.grok/memory/`) is not surfaced (off by default).
- **Junie transcripts read differently** — Junie stores an event-sourced UI
  stream (`events.jsonl`), not a chat log: no assistant prose and no thinking, so
  a session renders as tool/terminal/file blocks plus a final result. Expected,
  not a bug. Older Junie sessions also lack a recorded `cwd` (no `projectDir` in
  `index.jsonl`) and group under the `(unknown — Junie)` project bucket.
- **Junie "subagents" are NOT embeddable by design** — Junie delegates by running
  `junie …` as a plain terminal command, so children are independent sessions
  with zero ID linkage to the spawner (only the coincidental prompt text).
  Matching command text to session prompts would be heuristic and fragile, so
  they intentionally list as separate top-level sessions.
- **Never `scrollIntoView({ behavior: 'smooth' })` across the transcript.**
  Turns are lazily sized (`content-visibility: auto` with a 280px intrinsic
  size in `session.css`), so their real heights replace the estimates as the
  viewport passes them and the document shrinks by tens of thousands of pixels
  mid-animation — the scroll lands far past its target (the jump-menu bug on
  nested subagents). Navigate with an instant jump plus `holdAnchor` from
  `useScrollRestore.ts`, which re-pins the element each frame until layout
  settles and yields to the reader's own scroll.
- **Cost is a local estimate** from token usage × rates; not real billing.
  Computed once at index time and stored. Rates auto-refresh daily from LiteLLM
  at runtime (`pricing.fetched.json`); `pricing.json` is the fallback/override
  layer for families and the default rate. Usage is deduplicated by billed API
  call (`message.id`): multi-block splits and fork/resume copies repeat usage
  across rows, and only the canonical row (elected at index time) is counted.
  pi/Codex/opencode also record the serving *provider*, and pricing's
  `providers` section overrides model rates for it entirely (shipped defaults
  zero-rate local runtimes like LM Studio/Ollama). Pricing changes apply
  **prospectively** — cost is stamped per event at index time, so only an index
  rebuild re-prices already-indexed history. Rates are interpolated into SQL, so
  `loadPricing` validates them — an unusable rate is dropped, not passed through.
- **Context & compactions come from the index, not from a live process.**
  `sessions.context_tokens` is the prompt size (input + cache read + cache
  write) of the LAST main-thread assistant row, and `compaction_count` counts
  main-thread rows of the file-keyed `compactions` aux table. The API reports
  both as *absent* (not 0) for agents whose format never records them — decided
  in `data/agent-capabilities.ts`, never inferred from the data. Context needs
  **prompt-sized** rows (Claude Code, Codex, pi, opencode): Junie sums every LLM
  call of a turn into one row and Grok records one total per user turn, so a
  "context" read from them would be a fabrication, not merely session-level
  like Copilot's. Compaction
  markers differ per agent: Claude Code's is a `system`/`compact_boundary` row
  (the 2025 format flagged the summary user turn `isCompactSummary`; mid-period
  files carry both, so boundaries win and summaries are only counted in files
  with no boundary); Codex's is the top-level `compacted` record (the
  `compaction` item and `context_compacted` event belong to the same
  compaction — never count them); pi's is the `compaction` entry; Copilot's is
  `session.context_changed` with reason `compaction`. Normalizers synthesize
  the Claude Code system-row shape so the parser and the aux projection have one
  path; the window percentage is best-effort from pricing (`contextWindow`,
  LiteLLM `max_input_tokens`) and is never stored.
- **`loadFile` stages, then swaps — keep it that way.** It materializes the
  projection into temp tables *before* deleting the file's existing rows, so a
  failure while projecting (unreadable source, a bad rate reaching the
  interpolated cost expression) can't destroy already-indexed events. A
  transaction is not an option here — see the shared-connection note above.
- **`claudescope hook session-start` answers from stdin only** — it fires
  after a context compaction and prints the recovery pointer for that session.
  It must never touch the daemon (`ensureDaemon()` spawns and waits up to
  30 s), git, or the network: anything that blocks or exits non-zero shows up
  after every compaction in both harnesses. Recent sessions are deliberately
  NOT injected at session start (untrusted titles in every context, and
  `clear` asks for a fresh one) — that is the history skill's job, on demand.
  `plugins/claudescope/hooks/hooks.json` is shared by Claude Code and Codex:
  matcher `compact` only, no plugin-root variables, always exit 0.
- **Source paths reach DuckDB through `sqlPath()`, never `sqlString()`.**
  `read_ndjson` treats its path literal as a glob (`x[1].jsonl` reads
  `x1.jsonl`), so the path that is *read* is glob-escaped, while the
  `file_path` column and every `WHERE file_path =` keep the raw path because
  `files.path` is compared literally. Only the Claude Code connector reads
  source paths directly; the normalize cache's sha1 names carry no
  metacharacters.
- **Every SIGTERM of a recorded daemon PID goes through `terminateDaemon`**,
  which checks ownership first (`daemonOwnsPid` → `planWedgeAction`): a crashed
  daemon's PID can be recycled by an unrelated process, so `stop`, `restart`,
  `update`, the wedged path, and the version-skew heal must never
  `process.kill` the pid from `daemon.json` directly. The record is written by
  the server after a successful bind (`CLAUDESCOPE_DAEMON=1`), not by the
  spawner, so a losing concurrent spawn can never clobber it.
- **Release is maintainer-only** and tag-triggered (npm Trusted Publishing /
  OIDC). See `CONTRIBUTING.md`.

See `CONTRIBUTING.md` for the full workflow and `README.md` for user-facing docs.
