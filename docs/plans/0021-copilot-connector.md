# 0021 — GitHub Copilot CLI connector

- **Status:** in-progress <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-16
- **PR:** <link, once opened>

## Context

Claudescope already ingests Claude Code, Codex, Junie, pi, and opencode. The next
source is the **GitHub Copilot CLI** (`copilot`, package `@github/copilot`, the
standalone terminal agent — **not** the IntelliJ/IDE Copilot at
`~/.config/github-copilot`, which is out of scope here).

Direct inspection of a real local install (`~/.copilot`, copilotVersion `1.0.62`)
established the on-disk model:

- **`~/.copilot/session-store.db`** (SQLite) — a *derived* summary/FTS index
  (`sessions`, `turns`, `search_index`, mostly-empty `session_files` /
  `forge_trajectory_events` / `dynamic_context_items`). **Not** the source of truth.
- **`~/.copilot/session-state/<uuid>/events.jsonl`** — the **full transcript**, an
  event-sourced stream (Junie/pi-shaped). Each line: `{type, data, id, timestamp,
  parentId}`. This is what the connector reads.
- **`~/.copilot/session-state/<uuid>/workspace.yaml`** — session metadata: `cwd`,
  `git_root`, `repository`, `branch`, `name` (title), timestamps.
- **`~/.copilot/session-state/<uuid>/files/`** — persisted attachments (screenshots
  etc.), present **only when "store screenshots / session-level memory" is enabled**.
  Each file's basename equals the attachment's `displayName` in `events.jsonl`
  (e.g. `files/copilot-image-ae0f15.png`). The `user.message.attachments[].path` in
  `events.jsonl` still points at the now-deleted `$TMPDIR` copy, so the persisted
  file is resolved by `displayName`, not by that path.
- **`~/.copilot/session-state/<uuid>/session.db`** (SQLite) — per-session `todos`,
  `inbox_entries`, and `session_state(key,value)`. This is what **"session-level
  memory"** populates (facts + todos + attachments) when enabled — but it is
  **session-scoped** (deleted on `/clear`, never uploaded; Copilot states this
  in-transcript), **not** cross-session project memory. Not read by the connector.
- **`~/.copilot/copilot-instructions.md`** — the global, user-authored instruction
  file (analog of `~/.claude/CLAUDE.md`). The only cross-session/global memory.

Event types seen: `session.start` (carries `cwd`/`branch`/`repository`/`headCommit`),
`session.model_change` (`gpt-5-mini`), `session.info`, `session.context_changed`,
`system.message`, `user.message`, `assistant.turn_start|message|turn_end`,
`tool.execution_start|complete`, `hook.start|end`, `permission.requested|completed`,
`abort`, `session.shutdown`.

This is the established connector seam (`docs/plans/0004-connector-seam.md`): add a
connector under `packages/server/src/connectors/copilot/`, normalize in a
`prepare()` pass to canonical NDJSON (the Codex/pi/junie/opencode pattern), and the
shared index/FTS/cost paths stay untouched.

## Goal

A `copilot` connector that indexes Copilot CLI sessions into the shared schema:
browse/read/search the threaded transcript, Files-changed tab, per-session cost,
the agent badge in the UI, and global memory — all read-only, with `npm test` /
`npm run typecheck` / `npm run build` green and docs updated.

## Decisions

Resolved up front (these were the open questions from the surface-mapping pass):

- **Source = `events.jsonl`, not `session-store.db`.** The SQLite store is a lossy
  summary; the per-session event stream is full fidelity (tools, model, edits,
  tokens). Mirrors Junie/pi.
- **Connector id `copilot`, label `GitHub Copilot CLI`.** Free-string agent id (the
  shared package has no closed enum — confirmed), so no `packages/shared` change.
  Label disambiguates from the IDE Copilot.
- **`prepare()` → canonical NDJSON cache** under
  `~/.claudescope/cache/copilot/<hash>.ndjson` (opencode/pi pattern). The DuckDB
  projection reads the cache; YAML is parsed in TS (DuckDB can't read YAML), and
  `workspace.yaml name` is carried into the NDJSON as a `title` column.
- **File key = the `events.jsonl` absolute path** (Junie/pi style); session id =
  the `<uuid>` directory name. No opencode-style `#` synthetic key — each session
  is already its own file. `COPILOT_SESSIONS_DIR` env override covers multi-home.
- **Cost is session-granular and attaches to the final assistant row only.** Tokens
  exist *only* in `session.shutdown.modelMetrics`/`tokenDetails`; there is **no
  per-message usage**. Map `tokenDetails.input→input_tokens`,
  `cache_read→cache_read_tokens`, `output→output_tokens`,
  `cache_write→cache_write_tokens` (absent ⇒ 0). `message_id` is `NULL` on every
  row, so `electCanonicalUsage` treats all rows as canonical and the single
  token-bearing row is counted exactly once (no double-count). Distributing across
  rows was rejected — it complicates the cost SQL for no benefit.
- **No-shutdown sessions ⇒ zero cost.** A killed/crashed/still-running session has
  no `session.shutdown` (confirmed: one of the two local sessions had none). Leave
  token columns at 0/NULL; `buildCostExpr` yields 0. Documented as expected.
- **`gpt-5-mini` reasoning tokens are NOT added to output.** `tokenDetails.output`
  already equals `modelMetrics.outputTokens` and already includes reasoning (OpenAI
  semantics). Unlike opencode (which *adds* `reasoning` to `output`), here adding
  `reasoningTokens` would double-count. Use `tokenDetails.output` verbatim. (Verify
  during implementation against a fresh `session.shutdown`.)
- **Pricing: no change needed.** `gpt-5-mini` is already an exact entry in
  `packages/server/pricing.json` (`input 0.25 / output 2 / cacheRead 0.025 /
  cacheWrite 0`, schemaVersion 2). LiteLLM refresh keeps it current.
- **Screenshots → resolve from `files/<displayName>` to a real `ImageBlock`, with a
  text-marker fallback.** When screenshot saving is on, the attachment is persisted
  to `session-state/<uuid>/files/<displayName>`. In `loadSession`, for each image
  attachment, read `<sessionDir>/files/<basename(displayName)>` (basename only — no
  `..`/absolute traversal); if it exists, base64-encode and emit
  `ImageBlock{source:{type:'base64', media_type:<from ext>, data}}` (media type from
  extension: png/jpeg/gif/webp). If absent (saving was off — e.g. session
  `b34f5b75`), preserve the inline `[📷 displayName]` marker Copilot embeds in the
  message text. Image bytes are resolved at `loadSession` (session-detail) time, not
  indexed — the canonical NDJSON / FTS keeps only the text marker. This matches how
  Junie/Codex/opencode handle images and satisfies the "map images to ImageBlock"
  connector rule. Earlier `$TMPDIR`-only data (before saving was enabled) is the
  reason for the fallback, not a reason to skip image support. Non-image file
  attachments → `[file: displayName]` marker (rendering them is out of scope for v1).
- **Reasoning → empty thinking block (Codex pattern).** `reasoningOpaque` is
  encrypted; emit `{type:'thinking', thinking:'', signature: reasoningOpaque}`.
  `ThinkingBlock.signature` is optional and dropped at render, so the UI shows its
  standard "thinking content isn't stored" state.
- **Files-changed from successful edit tools (+ shutdown's `filesModified` as a
  cross-check).** The web changeset derives from `tool_use` blocks named
  `Edit`/`MultiEdit`/`Write` (`input.file_path` + `old_string`/`new_string`/`content`).
  Map `edit{path,old_str,new_str}→Edit{file_path,old_string,new_string}`,
  `create|write{path,content}→Write{file_path,content}`. A **denied** permission
  (`permission.completed.result.kind = 'denied-…'`) produces no successful
  execution, so denied edits never enter the changeset; render the attempt in-thread
  as a tool block with its denial result, but it counts as no file change.
- **Tool mapping by raw `toolName`** (lowercase), not `toolTitle` (a human phrase):
  `edit→Edit`, `view→Read`, `bash→Bash`, `create|write→Write`, `sql`/`ask_user`/
  others → passthrough tool blocks.
- **Memory: `globalMemory()` only.** Read `~/.copilot/copilot-instructions.md`
  (user-authored document). **Omit `projectMemory()`.** Enabling "session-level
  memory" does *not* change this: it persists facts/todos/attachments in the
  per-session `session.db` + `files/` (session-scoped, cleared on `/clear`), which
  is session content, not a cross-session per-project store — confirmed empty
  `dynamic_context_items` / `session_files` even after enabling it. Repo-local
  `.github/copilot-instructions.md` is project-dir-resident and out of scope by the
  Junie precedent. (Surfacing per-session todos/facts in the session-detail view is
  a possible future enhancement, not part of the memory viewer.)
- **Do NOT treat `session-state/<uuid>/session-config.json` as project memory.** When
  asked to "enable memory for all sessions in this folder," the Copilot *model*
  improvised that file (`{sessionMemoryEnabled, persist, autoSaveScreenshots}`) and
  itself described it as "a local marker file the CLI will need to consult" — a
  model-generated artifact, not a store Copilot maintains or reads back (and it's
  written inside one session's dir, so it can't scope a folder anyway). Copilot's
  real memory subsystem was `disabled` in every observed session (logs:
  "Memory is not enabled; skipping memory tools"), so its genuine on-disk format is
  **unconfirmed**. The connector must not infer memory from this file.
- **Tolerate unknown event types.** New/unseen types (e.g. `session.context_changed`)
  are skipped silently; the parser never throws on them.
- **Agent color: GitHub blue** (`#0969da` / dark accent `#58a6ff`) — free hue (pi
  is purple, Codex teal, Claude coral, Junie green).

## Approach

Ordered so each step type-checks before the next (config before connector before
registry, per the critic's build-ordering note).

1. **Confirm contracts (read-only).** Re-verify `CANONICAL_EVENT_COLUMNS`
   (`connectors/types.ts`), the `read_ndjson` projection in `pi/pi.ts` /
   `opencode/opencode.ts`, and `RawEvent`/block shapes in `shared/src/events.ts`.
   Read `pi/normalize.ts` end-to-end as the closest template (event stream →
   synthesized uuid chain → canonical rows + `SessionData`).
2. **`config.ts`** — add `COPILOT_SESSIONS_DIR` (`~/.copilot/session-state`, env
   override, `~` expanded) and `COPILOT_HOME = dirname(COPILOT_SESSIONS_DIR)`.
3. **`connectors/copilot/normalize.ts`** — `parseSession(eventsPath)`:
   - Read sibling `workspace.yaml` (lightweight TS YAML parse — title, cwd, branch,
     repository; fall back to `session.start.context` and first user message).
   - Stream `events.jsonl`; track current model from `session.model_change` /
     `assistant.message.model`.
   - Build `RawEvent[]` with a synthesized `<sessionId>-<seq>` uuid/parent chain:
     `user.message` → user turn (text; for each image attachment, resolve
     `<sessionDir>/files/<basename(displayName)>` → base64 `ImageBlock` when the file
     exists, else keep the inline `[📷 …]` marker; non-image files → `[file: …]`);
     `assistant.message` → assistant turn (text + `thinking` from `reasoningOpaque`
     + `tool_use` blocks from `toolRequests`, mapped to canonical names);
     `tool.execution_complete` → synthetic user turn with `tool_result` (paired by
     `toolCallId`); `permission.*`/`hook.*`/`system.message`/`session.info`/unknown
     → skipped (or denial annotated on the tool block).
   - `toCanonicalRows()` — flatten to canonical columns; attach `session.shutdown`
     token breakdown to the final assistant row only; `message_id`/`forked_from_session_id`
     = NULL; `is_sidechain`=false; `service_tier`=null; carry `title`.
4. **`connectors/copilot/memory.ts`** — `globalMemory()` reads
   `~/.copilot/copilot-instructions.md` (mirror `codex/memory.ts`: `user-authored`,
   `kind:'document'`, graceful-empty, `contractHome` path, mtime `updatedAt`).
5. **`connectors/copilot/copilot.ts`** — `AgentConnector`: `discover()` walks
   `COPILOT_SESSIONS_DIR/*/events.jsonl` (mtime/size); `prepare()` →
   `parseSession`+`toCanonicalRows` → cache NDJSON; `eventsProjectionSql()` reads
   the cache (clone pi/opencode `read_ndjson` projection, +`message_id`/`forked_from_session_id`
   NULL); `auxProjections()` returns `titles` from the carried `title`; `loadSession()`
   → `{ mainEvents, subagents: [] }`; wire `globalMemory`.
6. **`connectors/registry.ts`** — import + append `copilotConnector`.
7. `npm run typecheck` (server green before touching the web).
8. **Web** — `AgentBadge.tsx`: `copilot: 'GitHub Copilot CLI'`; `browse.css`: dark +
   light `.tv-agent--copilot` color rules. (Image placeholder, empty-thinking, memory
   tab, and agent filter are already dynamic/graceful — no changes.)
9. **`test/copilot.integration.test.ts`** — synthetic `~/.copilot/session-state/<id>/`
   in a temp dir; build a real index; assert the weird edges (below).
10. **Docs** — `CLAUDE.md` (connector table row + Gotchas), `README.md` (agents +
    `COPILOT_SESSIONS_DIR` + privacy source list), `CONTRIBUTING.md` (format list),
    `SECURITY.md` (read path). Set this plan to `in-progress`, then `done` + PR link
    at PR time.
11. `npm test` and `npm run build` green.

## Files affected

- `packages/server/src/config.ts` — `COPILOT_SESSIONS_DIR`, `COPILOT_HOME`.
- `packages/server/src/connectors/copilot/copilot.ts` — **new**, the connector.
- `packages/server/src/connectors/copilot/normalize.ts` — **new**, `events.jsonl` → canonical rows + `SessionData`.
- `packages/server/src/connectors/copilot/memory.ts` — **new**, `globalMemory()`.
- `packages/server/src/connectors/registry.ts` — register `copilotConnector`.
- `packages/web/src/components/AgentBadge.tsx` — label entry.
- `packages/web/src/pages/browse/browse.css` — agent color (dark + light).
- `packages/server/test/copilot.integration.test.ts` — **new**, integration test.
- `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md` — docs.
- *No change:* `packages/shared/*` (free-string agent id), `pricing.json`
  (`gpt-5-mini` already present), `data/index.ts` (generic cost/dedup already fit),
  `scripts/bundle.mjs` (no per-connector asset).

## Testing

`npm test` + `npm run typecheck` + `npm run build`. The integration test builds a
real DuckDB index from synthetic fixtures in a temp dir (never touches real
`~/.copilot`), asserting the bug-prone edges:

- **No `session.shutdown` ⇒ zero cost**, session still indexes and renders.
- **Cost counted once** — multi-assistant-turn session, tokens on the final row only;
  total cost == the session's shutdown tokens × rates (no inflation).
- **`gpt-5-mini` resolves** to the priced rate (non-zero cost when shutdown present).
- **Denied edit excluded** from Files-changed; **successful `edit`** appears as an
  `Edit` change with correct add/remove counts.
- **Saved screenshot resolves** — a session with `files/<displayName>.png` renders a
  base64 `ImageBlock`; a session whose `files/` is empty/absent keeps the
  `[📷 name]` marker and produces no broken image block. `displayName` containing
  `..`/a slash is treated as basename only (no path traversal outside `files/`).
- **Unknown event type** (`session.context_changed`) is skipped without error;
  truncated/malformed trailing line tolerated.
- **`globalMemory()`** returns the `copilot-instructions.md` doc; returns `[]` when absent.
- **Title** = `workspace.yaml name`, with first-user-message fallback when empty.

## Risks / open questions

- **Token semantics for reasoning** — the plan assumes `tokenDetails.output` already
  includes reasoning (so we don't add `reasoningTokens`). Verify against a fresh
  `session.shutdown` during step 3; if reasoning is *additive*, fold it into output
  to match the codebase convention.
- **`workspace.yaml` parsing** — pick a minimal dependency-free YAML read (only a few
  scalar keys needed); don't add a YAML dep without discussion. Missing/!readable
  `workspace.yaml` must degrade to `session.start` + first-user-message, not crash.
- **In-place rewrite on `rewind`** — Copilot has rewind snapshots; if `events.jsonl`
  is ever rewritten in place, mtime/size change still triggers a full re-derive
  (the cache NDJSON is rebuilt from scratch each `prepare()`), so it's robust by
  design. If a real user reports stale tokens after a rewind, revisit.
- **Screenshots added after indexing** — `files/` resolution happens live in
  `loadSession`, so toggling screenshot saving on after a session is indexed needs
  no re-index; the image just appears in the detail view. Conversely, the `files/`
  dir is *not* part of change detection (only `events.jsonl` mtime/size is) — fine,
  since image bytes aren't indexed. Reading `files/` is read-only; ignore the
  `inuse.<pid>.lock` (we never lock or write).
- **Session-level memory is session-scoped** — facts/todos in `session.db` are
  per-session and `/clear`-able; deliberately not surfaced in the memory viewer.
  Revisit only if Copilot adds a cross-session store (e.g. populates
  `dynamic_context_items` or a documented per-project file).
- **Copilot's real memory feature was never enabled on the inspected machine**
  (logs: "Memory enablement check: disabled"), so the on-disk format of genuine
  project/cross-session memory — if it ships one — is unconfirmed. The plan
  implements `globalMemory()` only; if a user with the feature *enabled* surfaces a
  real store (most likely `dynamic_context_items`), add `projectMemory()` then. Do
  not build against the model-improvised `session-config.json`.
- **Subagents** — not observed; `loadSession` returns `subagents: []`. If Copilot
  adds nested agents later, extend then.
- **Two Copilot products** — this connector is the CLI (`~/.copilot`) only; the
  IntelliJ/IDE store (`~/.config/github-copilot`, `copilot-intellij.db`) is a
  separate, future connector.
- **Per-project memory** — deliberately omitted; revisit only if a real
  `dynamic_context_items` population (or a documented per-project file) appears.
