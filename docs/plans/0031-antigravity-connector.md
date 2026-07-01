# 0031 — Google Antigravity connector

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-01
- **PR:** https://github.com/vladar107/claudescope/pull/42

## Context

Google is retiring **Gemini CLI** and consolidating its coding agents into
**Antigravity 2.0** (desktop app + a Go CLI, `agy`). As of May 19 2026 Google
announced the Gemini CLI → Antigravity CLI transition; on June 18 2026 Gemini CLI
stopped serving consumer requests. So for a transcript viewer, Antigravity is
where new activity now lands — the right source to add, and Gemini CLI is a
deprecated long tail we intentionally skip.

This adds a seventh connector: **Antigravity**, following the event-sourced
pattern (`prepare()` normalizes each session to canonical NDJSON, then the shared
index/FTS/cost paths take over). Closest template: the **Copilot** connector;
subagent nesting mirrors **Claude Code**.

### On-disk format (verified against real local data at `~/.gemini/antigravity-cli/`)

- **Data root(s):** `~/.gemini/antigravity-cli/` (CLI) and `~/.gemini/antigravity/`
  (desktop) share the shape; one connector scans both.
- **Transcript:** `<appDataDir>/brain/<conv-id>/.system_generated/logs/transcript_full.jsonl`
  (authoritative; the buggy truncated `transcript.jsonl` is ignored). Each line is
  `{step_index, source, type, status, created_at, content, thinking?, tool_calls?}`.
- **`type`s:** `USER_INPUT` (wrapped in `<USER_REQUEST>`, with model in
  `<USER_SETTINGS_CHANGE>` and uploaded-image paths in `<ADDITIONAL_METADATA>`),
  `PLANNER_RESPONSE` (assistant prose + PLAINTEXT `thinking` + `tool_calls`),
  `VIEW_FILE`/`LIST_DIRECTORY`/`CODE_ACTION` (tool *results*, correlated to their
  call by type + order), `SYSTEM_MESSAGE` (subagent result, carries
  `sender=<sub-id>`), `GENERIC`; `CHECKPOINT`/`CONVERSATION_HISTORY` are dropped.
- **cwd** is out-of-band in `<appDataDir>/history.jsonl` (`conversationId → workspace`);
  fallback `(unknown — Antigravity)`.
- **No token counts** anywhere (the per-conversation SQLite DB is opaque protobuf),
  so cost is unavailable by design (zero usage, counted once).
- **Subagents** run as separate conversations (`invoke_subagent`), linked only by
  text (`SYSTEM_MESSAGE sender=`, "Conversation ID:").
- **Tools:** `write_to_file`→`Write`, `view_file`→`Read`, `list_dir`, shell→`Bash`,
  `invoke_subagent`→one `Task` per subagent. Images: `brain/<id>/uploaded_media_*.png`.

## Decisions

- **One connector, both appDataDirs, id `antigravity`, label `Antigravity`.**
- **Ship without cost** — tokens only recoverable via brittle protobuf field-guessing
  (no schema in the `agy` binary; `/usage` is server-side); guessed numbers would
  corrupt cost analytics. `message_id` NULL → always canonical at zero.
- **Full subagent nesting** — subagent conversations are re-parented under their root
  session (`is_sidechain`, so they aren't orphan sessions) and nested via the
  existing `buildSubagentRuns`/`SubagentBlock` machinery, anchored to the parent's
  `invoke_subagent`→`Task` call (matched by description + type).
- **Plaintext thinking renders** — Antigravity joins pi as an exception to the
  "thinking renders empty" gotcha.

## Approach

New `packages/server/src/connectors/antigravity/`: `antigravity.ts`, `normalize.ts`,
`memory.ts` (mirrors `connectors/copilot/`; subagents modeled on `claude-code`).

1. **Config** — `ANTIGRAVITY_CLI_DIR`, `ANTIGRAVITY_DESKTOP_DIR` (env `ANTIGRAVITY_DIR`),
   `ANTIGRAVITY_DIRS`, `ANTIGRAVITY_HOME` (= `~/.gemini`, for memory).
2. **`discover()`** — glob both appDataDirs' `brain/*/…/transcript_full.jsonl`.
3. **Subagent linkage map** (`normalize.ts`, per-appDataDir, mtime-memoized) — zip each
   conversation's ordered `invoke_subagent` prompts against the child ids it references.
4. **`parseAntigravitySession`** — build canonical events; re-parent a subagent under its
   root (`session_id = root`, `is_sidechain = true`); strip the `<USER_REQUEST>` wrapper;
   parse the model; correlate typed result records to their calls (FIFO by kind),
   synthesizing a `Read`/`list_dir` pair for an orphan result; render `SYSTEM_MESSAGE`
   summaries; resolve `uploaded_media_*.png` → base64 `ImageBlock` (contained to the conv
   dir); zero tokens, NULL message_id.
5. **`antigravity.ts`** — `prepare()`→cache NDJSON, standard `eventsProjectionSql`,
   `loadSession` splits main vs. subagent transcripts, `globalMemory`,
   `resumeSpec: ['agy','--conversation',id]`.
6. **Register** in `connectors/registry.ts`; web `AgentBadge` label + `browse.css` chip;
   docs (README + CLAUDE.md). No pricing/parser change.

## Files affected

- `packages/server/src/config.ts` — Antigravity path constants.
- `packages/server/src/connectors/antigravity/{antigravity,normalize,memory}.ts` — new.
- `packages/server/src/connectors/registry.ts` — register.
- `packages/web/src/components/AgentBadge.tsx`, `packages/web/src/pages/browse/browse.css` — label + colors.
- `packages/server/test/antigravity.integration.test.ts` — new test; every other
  integration test gains `ANTIGRAVITY_CLI_DIR`/`ANTIGRAVITY_DIR` empty-dir neutralization
  (like every other agent), and `memory-overview.test.ts` adds `antigravity` to its list.
- `README.md`, `CLAUDE.md` — docs.

## Testing

- `npm run typecheck` + `npm test` green (279 tests). New integration test covers the
  weird stuff: subagent re-parenting (child never a standalone session) + nesting under
  the `Task` call, cwd-from-history + unknown fallback, wrapper-stripped title + model
  parse, plaintext thinking, `write_to_file`→Write, orphan result → synthesized Read,
  tool call/result correlation, image → ImageBlock, `SYSTEM_MESSAGE` summary,
  CHECKPOINT/CONVERSATION_HISTORY dropped, zero cost, global `AGENTS.md` memory.
- **Manual E2E** (real `~/.gemini`, throwaway index): 3 real sessions indexed, the real
  `research` subagent re-parented + nested under its `Task` call (30 items), tools
  `list_dir`/`Task`/`Write`, plaintext thinking, and 2 real uploaded screenshots → base64
  `ImageBlock`.

## Risks / open questions

- **Undocumented, closed-source format** — the `agy` binary can change record/tool shapes
  without notice; parse defensively (unknown types/tools tolerated, `ignore_errors=true`;
  the indexer isolates a throwing connector).
- **Subagent correlation is text-based** — multiple subagents per call, nested/recursive
  subagents, and orphan children fall back to standalone sessions / unanchored runs rather
  than dropping data. Nested (grandchild) subagents render unanchored (their spawn is in a
  sub-thread, which `buildSubagentRuns` doesn't scan).
- **Unconfirmed tool shapes** — no diff/edit or shell tool seen yet; `write_to_file`→Write
  is confirmed, shell→Bash / `replace_file_content`→Edit are best-effort until a sample
  appears.
- **Cost permanently unavailable** unless a validated token source appears (would need
  live `/usage` ground truth vs. the `gen_metadata` protobuf — a separate spike).
