# 0020 — opencode connector

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-15
- **PR:** https://github.com/vladar107/claudescope/pull/23

## Context

[opencode](https://opencode.ai) (v1.17.7) is the first agent whose transcripts
are **not** per-session files: it stores everything in **one SQLite database**,
`~/.local/share/opencode/opencode.db` (+ `-wal`/`-shm`). Schema (verified):

- `session(id, project_id, directory[=cwd], title, model, agent, tokens_input,
  tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost,
  parent_id, time_created, time_updated, …)`
- `message(id, session_id, time_created, time_updated, data JSON)` —
  `data: {role, time, agent, model:{providerID,modelID,variant}, tokens:{total,
  input,output,reasoning,cache:{write,read}}, cost}`
- `part(id, message_id, session_id, time_created, time_updated, data JSON)` —
  `data.type ∈ {text, reasoning, tool, file, patch, step-start, step-finish}`.
  Live transcript lives in `message`+`part` (the `event`/`event_sequence` tables
  are an audit log, `session_message` is empty).
  - **`tool`** parts: `{type:'tool', tool, callID, state:{status, input, output,
    metadata, error, …}}`. opencode's tools (verified): `apply_patch`, `bash`,
    `read`, `grep`, `glob`, `webfetch`, `skill`, `todowrite`. **File edits go
    through `apply_patch`** — `state.input.patchText` is the OpenAI **V4A diff**
    (`*** Begin Patch` … `*** Add/Update/Delete File: <path>` … `@@` hunks …
    `*** End Patch`); completed patches also carry `state.metadata.files[]`
    (`{type:'add'|'update'|'delete', patch, additions, deletions}`).
  - **`file`** parts (images): `{type:'file', mime:'image/png', filename, url}`
    where `url` is an inline `data:<mime>;base64,…` URL — this is how opencode
    stores a **pasted screenshot** (on the user message), not a tool result.
  - **`patch`** parts: `{type:'patch', hash, files:[paths]}` — git-style snapshot
    markers (no diff content); dropped.

The connector seam already supports this: `discover()` is the **sole source of
truth** for what "files" exist and the indexer never `stat`s `file.path`, so each
**session becomes a synthetic `DiscoveredFile`** and `prepare()` extracts it to a
cache NDJSON — exactly the Codex pattern, just sourced from SQLite instead of a
file. The hot path (DuckDB `read_ndjson` → FTS → cost) stays byte-identical.

**Node 24 ships `node:sqlite` built-in → zero new dependencies.** A read-only
`DatabaseSync({readOnly:true})` reads the live WAL'd DB cleanly (stress-tested:
200 concurrent read-opens vs 1000 writes + checkpoints, 0 errors, always the
latest committed value).

## Goal

opencode sessions are indexed, browsable, searchable, costed, and render with
text, **plaintext reasoning**, tool calls + results, a populated **Files-changed
tab**, and embedded **screenshots** — merged per `cwd`, tagged with an `opencode`
badge — reading the SQLite DB strictly read-only, with correct incremental change
detection and no cross-connector blast radius. Per the connector process rule
(learned on pi), wiring the Files-changed tab and image embedding is mandatory,
not optional — the Claude-centric web UI shows nothing for them otherwise.

## Decisions

- **SQLite via `node:sqlite`, read-only, no new dep.** Open `{readOnly:true}`,
  read, close, in each entry point (`discover`/`prepare`/`loadSession`); never
  open read-write; never touch `-wal`/`-shm`.
- **One synthetic `DiscoveredFile` per session**, `path = "<dbPath>#<sessionId>"`
  (opencode ids are `ses_<base62>` — no `#`, so the split is unambiguous).
- **Change signal = `max(session.time_updated, max(message.time_updated),
  max(part.time_updated))`** per session (computed in one SQL aggregate);
  `size` = a monotonic-on-change integer (`count(parts)+count(messages)`).
  `session.time_updated` alone **lags** the last turn (verified by ~66ms) and
  would miss edits.
- **🔴 Harden the prune loop against all-or-nothing wipeout.** The indexer's prune
  loop (`index.ts` ~L375, `for (const path of existing.keys())` — **verified still
  NOT connector-scoped in main**) deletes any indexed path not returned by
  `discover()` this pass. Because all opencode sessions sit behind one DB handle, a
  `discover()` that returns `[]` on a transient open failure
  (`SQLITE_BUSY`/`CANTOPEN` during opencode's checkpoint/crash-recovery) would
  **purge every opencode session at once**, then re-extract + full-rebuild next
  pass. Two fixes (both still TODO):
  1. **`existsSync`-guard `discover()`** — verified `DatabaseSync(path,
     {readOnly:true})` **throws** `ERR_SQLITE_ERROR` on a missing file. So: DB file
     absent → return `[]` (~0.008ms; opencode not installed); file present but
     open/query fails → **throw** (the prune then treats nothing as deleted). This
     is load-bearing precisely because the prune is not connector-scoped.
  2. **Connector-scoped prune (general hardening):** scope the prune to files whose
     `connector_id` discovered this pass — `files` already stores `connector_id`.
     Bounds the blast radius so one connector's hiccup can't purge another's.
     *(Touches `data/index.ts`; small.)*
- **🟢 Files-changed tab — parse `apply_patch`, map the other tools** (mandatory;
  the web `changeset.ts` + `ToolBlock` key off Claude tool names + `file_path`, so
  without this the tab is empty and tools render as raw JSON). Extend pi's
  `toolUseBlock()` switch (`pi/normalize.ts` is the template — pi maps 1:1; opencode
  fans 1:N). A pure, fixture-tested `parseApplyPatch(patchText)` turns one
  `apply_patch` part into 1..N canonical tool_use blocks:
  - `*** Add File:` → **`Write`** `{file_path, content}` (body lines are `+`-only;
    strip the single leading `+`).
  - `*** Update File:` → **`MultiEdit`** `{file_path, edits:[{old_string,
    new_string}]}`, one edit per **bare `@@`** hunk (no line numbers); carry context
    (` `) lines into BOTH sides; strip exactly one prefix char (never trim — keep
    leading whitespace).
  - `*** Delete File:` → **`Edit`** `{file_path, old_string:<removed body>,
    new_string:''}`. The removed body is **not** in `patchText` (V4A delete has no
    body) — recover it from `state.metadata.files[]` (the matching `delete` entry's
    `patch` `-` lines); fall back to `'(file deleted)'` only when metadata is absent
    (the error/rejected case). `patchText` is the **primary** source for Add/Update;
    `metadata.files[]` is the source for Delete bodies.
  - Other tools: `read` → **`Read`** (rename `state.input.filePath` →`file_path`;
    keep `offset`/`limit`); `bash` → **`Bash`** (`command`/`timeout`/`description`;
    drop `workdir`); `grep`/`glob`/`webfetch`/`skill`/`todowrite` → **passthrough**
    (no special `ToolBlock` renderer exists → generic JSON; acceptable). Pair
    `tool_use`↔`tool_result` by **`callID`**; `state.status==='error'` (or
    `state.error`) → `tool_result` `isError`, but still emit the canonical block so
    the attempted edit shows. Drop the standalone `patch` snapshot parts (no diff;
    would double-count files already covered by `apply_patch`).
  - Tolerate malformed `patchText` (missing `@@`, mixed prefixes) — never throw;
    fall back to a generic block (the codex/pi "tolerate corrupt line" discipline).
  - **Avoid redundant result text**: `read` output is wrapped
    `<path>…</path><type>…</type><content>…</content>` — unwrap to the `<content>`
    body (the `Read` header already shows the path). And each `apply_patch` file
    block gets a CONCISE per-file result (`Updated <file>`), not the shared
    multi-file "Success. Updated …" summary repeated on every fanned block.
  - *Sibling finding (out of scope):* Codex emits `apply_patch` as a heredoc inside
    `exec_command`, so **Codex edits also miss the Files-changed tab today**.
    Consider extracting `parseApplyPatch` to a shared `connectors/` util so a future
    Codex sniffer can reuse it.
- **🟢 Screenshots — implement now (verified present).** opencode stores a pasted
  image as a **`file` part** on the user message: `{type:'file', mime:'image/png',
  url:'data:image/png;base64,…'}`. Add a `part.data.type === 'file'` branch that,
  when `mime` starts with `image/`, emits a canonical `ImageBlock`
  `{type:'image', source:{type:'url', url: data.url}}` (a `data:` URL renders as a
  `url` source via `extractImage`; no base64 splitting) into the message's content
  array. Guard `typeof url === 'string' && url.length > 0`; pass non-image file
  parts through as a text marker. (The earlier "no images in the DB" note was wrong
  — there is a real clipboard screenshot file part.) The merged `ToolBlock` `Read`
  tweak also covers any future image that arrives in a tool result.
- **🟢 Pricing + lazy pricing-sync are ALREADY DONE in main** (pi PR #22): the full
  OpenAI lineup incl. `gpt-5.4-mini-fast` is in `pricing.json` (so opencode cost
  resolves), and the `pricing_rates` table now builds lazily (only on the first
  file load), so opencode's per-poll no-op reindex pays no pricing cost. No pricing
  work in this PR.
- **Normalize at MESSAGE granularity, not part.** One `message` row per turn;
  `message.data.tokens` == the lone `step-finish` part's tokens == per-turn billed
  usage (verified: `SUM(message tokens)` equals the `session.tokens_*` columns
  exactly). Summing `step-finish` parts on top would double-count. Add a dev
  assertion that there's ≤1 `step-finish` per message so a future multi-step turn
  is caught, not silently mis-costed.
- **Token map differs from Codex — no input subtraction.** opencode `input` is
  cache-**exclusive** (`total = input+output+reasoning+cacheR+cacheW`), so
  `input_tokens = tokens.input` directly. **Fold reasoning into output:**
  `output_tokens = tokens.output + tokens.reasoning` (no canonical reasoning
  column; reasoning is output-side, billed at the output rate). `cache_read =
  tokens.cache.read`, `cache_write = tokens.cache.write`, `service_tier = NULL`.
- **Reasoning is PLAINTEXT** → `reasoning` part → `{type:'thinking',
  thinking: part.data.text}` (renders content + FTS-searchable). The
  "thinking renders empty" gotcha does **not** apply to opencode.
- **`message_id = NULL`** (one row per billed turn, no multi-block/fork
  duplication) → always usage-canonical, no dedup logic.
- **Title from `session.title`** via `auxProjections` (opencode stores a real
  per-session title, unlike Codex). Carry it through the cache NDJSON like Junie;
  the first-user-message fallback still applies when blank.
- **Synthesize a sequential `uuid`/`parentUuid` chain** in `time_created` order
  (Codex pattern); don't trust `data.parentID`.
- **`sourceDir` = the data dir** (`~/.local/share/opencode`, where the DB lives);
  `/api/sources` only `existsSync`es it. No config-dir constant is needed (memory
  is skipped — see below).
- **Sub-sessions deferred.** `session.parent_id` exists but is unpopulated here;
  ship `subagents: []` and index any child session as its own top-level session.

## Memory — skipped (decided)

opencode keeps **no agent-distilled memory in its own home/config dir**. What it
reads at runtime is repo-local `CLAUDE.md`/`AGENTS.md` and the global
`~/.claude/CLAUDE.md` — all out of scope under (or only relaxable by changing) the
home-dir-only invariant. **Maintainer decision: skip memory for both pi and
opencode.** The connector implements **neither** `globalMemory()` **nor**
`projectMemory()`; opencode is a transcript-only source and does not appear in the
memory viewer. Consequently `OPENCODE_CONFIG_DIR` is **not** needed — only the data
dir (where the DB lives) matters.

## Approach

1. `config.ts` — `OPENCODE_DATA_DIR` (`~/.local/share/opencode`, honoring
   `$XDG_DATA_HOME`) and derived `OPENCODE_DB_PATH = join(dataDir,'opencode.db')`,
   env-overridable. (No config dir — memory skipped.)
2. `connectors/opencode/db.ts` — tiny read-only `node:sqlite` helper (open/read/
   close; `[]`/throw discipline from the prune-loop decision).
3. `connectors/opencode/normalize.ts` — session rows → canonical NDJSON rows and
   → `RawEvent[]` (shared builder): message-granular tokens (input direct, reasoning
   folded into output; dev-assert ≤1 `step-finish`/message), plaintext `reasoning`
   → thinking block, `tool` parts → canonical tool_use (incl. `parseApplyPatch()`
   for `apply_patch`, `read`→`Read`, `bash`→`Bash`, rest passthrough) paired to
   `tool_result` by `callID`, image `file` parts → canonical `ImageBlock`, drop
   `patch`/`step-*` parts. `parseApplyPatch()` is a pure, fixture-tested helper
   (consider a shared `connectors/` util — Codex can reuse later).
4. `connectors/opencode/opencode.ts` — the `AgentConnector` (`discover` w/ synthetic
   keys + aggregate mtime + `existsSync`-guard; `prepare` → cache NDJSON;
   `eventsProjectionSql` identical to Codex; `auxProjections` → titles;
   `loadSession`). No memory methods.
5. `connectors/registry.ts` — register `opencodeConnector`.
6. `data/index.ts` — connector-scoped prune guard (hardening decision #2; still
   TODO — verified the prune loop is not connector-scoped in main).
7. **Perf isolation** — `perf/run.ts` MUST set `OPENCODE_DB_PATH`/`OPENCODE_DATA_DIR`
   to an empty temp path (alongside the existing `CODEX`/`PI` isolation) BEFORE
   registering the connector, or a dev `npm run bench` on a machine with a real
   `~/.local/share/opencode/opencode.db` pays the per-poll `discover()` query and
   trips the noop-reindex gate (~+34% measured). CI (ubuntu, no DB) is safe; the
   absent-DB `discover()` is ~0.008ms. Add the same isolation to the integration/
   pricing/dedup/recovery suites.
8. Web — `AgentBadge.tsx` `'opencode' → 'opencode'`; `browse.css`
   `.tv-agent--opencode` colors. No other web changes: the `ToolBlock` `Read`
   image tweak is already in main, and `grep`/`glob`/`webfetch`/`skill`/`todowrite`
   intentionally render as generic JSON (no special renderer — acceptable).
9. Docs — `README.md` (SQLite source row), `CLAUDE.md` (gotchas: SQLite-backed
   source; opencode reasoning renders plaintext; `apply_patch`→canonical edits).

## Files affected

- `packages/server/src/config.ts` — `OPENCODE_DATA_DIR` + `OPENCODE_DB_PATH` (no
  config dir — memory skipped).
- `packages/server/src/connectors/opencode/{db,normalize,opencode}.ts` — new
  connector incl. the `parseApplyPatch()` helper and the image `file`-part branch
  (no `memory.ts`; memory skipped).
- `packages/server/src/connectors/registry.ts` — register.
- `packages/server/src/data/index.ts` — connector-scoped prune guard (still TODO).
- `packages/web/src/components/AgentBadge.tsx`, `pages/browse/browse.css` — label +
  badge color only (the `ToolBlock` `Read` image tweak is already in main).
- `packages/server/perf/run.ts` + the integration/pricing/dedup/recovery suites —
  add `OPENCODE_DB_PATH`/`OPENCODE_DATA_DIR` isolation (perf gate + determinism).
- `packages/server/test/opencode.integration.test.ts` — new suite (build a
  synthetic `opencode.db` in a temp dir; never touch real `~/.local/share`).
- `README.md`, `CLAUDE.md`, `docs/plans/README.md`.

## Testing

`npm run typecheck` + `npm test`. Fixtures build a real throwaway SQLite DB and
target the edges:

- **token additivity** — per-message tokens (input direct, reasoning folded into
  output) sum to the `session.tokens_*` columns; a `gpt-5.4-mini-fast` turn costs
  at `0.75/4.50/0.075`.
- **change detection** — appending a `part` (last-turn edit) bumps the aggregate
  mtime so the session re-indexes; an untouched session is skipped.
- **prune resilience** — a `discover()` that throws (DB present but unreadable)
  must NOT purge previously-indexed opencode sessions (and must never touch other
  connectors' files).
- **plaintext reasoning** renders / reaches `text_content`.
- **tool_use ↔ tool_result** pairing by `callID`; `step-*`/`patch` parts dropped.
- **no double-count** — message-level aggregation vs `step-finish` parts.
- **`parseApplyPatch()` weird cases** (pure unit test): a bare-`@@` Update hunk with
  context lines carried into both sides; a multi-file patch (Add + Delete) fanning
  one part → N canonical blocks; Add File → `Write`; Delete File → `Edit` with the
  removed body from `metadata.files[]`; the error/rejected patch (no metadata →
  `'(file deleted)'` marker + `isError`); CRLF normalization; strip exactly one
  prefix char (preserve leading whitespace).
- **Files-changed tab** — the parsed `apply_patch` edits appear in `buildChangeset`
  (file_path + add/remove counts).
- **screenshot** — an image `file` part becomes a canonical `ImageBlock`
  (`source.type==='url'`, `data:` URL) on the message.
- **OPENCODE_DB_PATH isolation** — bench/test harness points at an absent temp DB
  so `discover()` returns `[]` cheaply and runs stay deterministic.

## Risks / open questions

- **Delete-File fidelity** — V4A `*** Delete File:` carries no body; the removed
  content comes from `state.metadata.files[]`, which is absent on error/rejected
  patches → those show as a `'(file deleted)'` marker rather than a full diff.
  Best-effort, documented.
- **`apply_patch` parse robustness** — bare `@@` hunks have no line numbers, so
  old/new are reconstructed purely from prefixes; malformed `patchText` must be
  tolerated (fall back to a generic block, never throw). Lock down with fixtures.
- **Generic-rendered tools** — `ToolBlock` has no `Grep`/`Glob`/`WebFetch`/`Skill`/
  `TodoWrite` case, so those render as JSON. Acceptable (not a bug); pretty
  renderers would be separate web work, out of scope.
- **Dev-bench perf** — only an issue if `perf/run.ts` isn't isolated (a real local
  opencode DB makes `discover()` pay per poll, ~+34%). CI is unaffected. Mitigated
  by the `OPENCODE_DB_PATH` isolation step.
- **Sub-sessions** (`session.parent_id`) — none populated to validate nesting;
  shipped as own-session for now.
- **XDG / OS paths** — confirm the Linux/Windows data location beyond the macOS
  `~/.local/share` tested here.
- **Pricing** — resolved: `gpt-5.4-mini-fast` is priced (as standard `gpt-5.4-mini`,
  no official `-fast` SKU) and the lineup/lazy-sync shipped in PR #22. Revisit only
  if opencode is found to bill a priority tier.
