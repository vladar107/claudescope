# 0008 — Junie connector (third agent)

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-09
- **PR:** `feat/junie-connector`

## Context

The third agent: **JetBrains Junie**. Built against Junie's real on-disk format
(`~/.junie/`, build `1892.22`), not docs. Sessions live at
`~/.junie/sessions/index.jsonl` (one line/session: `sessionId`, `createdAt`,
`updatedAt`, `taskName`, sometimes `projectDir`) plus
`~/.junie/sessions/session-<id>/events.jsonl`.

Unlike Claude (flat per-row) and even Codex (multi-record but conversational),
Junie's transcript is an **event-sourced UI render stream**: ~96% of lines are
`SessionA2uxEvent` wrappers around a nested `agentEvent`. There is no assistant
prose and no `uuid`/`parentUuid` threading — assistant output is a sequence of
block-update events (`Tool`/`Terminal`/`ViewFiles`/`FileChanges`BlockUpdated)
keyed by `stepId` and emitted repeatedly (IN_PROGRESS→COMPLETED), capped by a
final `ResultBlockUpdatedEvent`.

## Goal

Index and render Junie sessions end-to-end (browse / search / analytics +
threaded detail, with cost via existing pricing), reusing 0004's canonical
schema, cost, FTS, and thread assembler — Claude/Codex untouched.

## Decisions

- **`events.jsonl` only as source of truth** (user-confirmed). The per-task
  `.matterhorn/trajectory/*.jsonl` holds a richer role-tagged conversation but is
  compressed, undocumented internal state that may shift between versions —
  rejected for robustness.
- **Codex-style `prepare()` → temp NDJSON.** `parseSession` walks the stream in
  TS into Claude-shaped `RawEvent[]`; `toCanonicalRows` flattens to canonical
  rows written under `~/.claudescope/cache/junie/`; `eventsProjectionSql` reads
  that 1:1. Mirrors `connectors/codex/`.
- **Stream → conversation mapping:** each top-level `UserPromptEvent` opens a
  user turn (and flushes the pending assistant turn). Block events are coalesced
  by `stepId` (last write wins) into one `tool_use`+`tool_result` pair each;
  `ResultBlockUpdatedEvent.result` becomes a trailing assistant `text` block.
  uuids/parentUuids are synthesized sequentially. Noise (`AgentCurrentStatus…`,
  `AgentStateUpdated`, context/tips) is dropped.
- **Tokens & model** summed from `LlmResponseMetadataEvent.modelUsage[]`
  (`inputTokens`→input, `outputTokens`→output, `cacheInputTokens`→cache_read,
  `cacheCreateTokens`→cache_write); Junie's pre-computed `cost` is ignored — cost
  is derived centrally from `pricing.json`. Junie spans providers (Claude/GPT/
  Gemini); unknown models fall to the default rate.
- **Title** from index `taskName` / `AgentTaskNameUpdatedEvent` via an aux
  `titles` projection over the cache file; falls back to the generic first-user
  snippet if absent.
- **cwd** resolves: index `projectDir` → last non-empty
  `CurrentDirectoryUpdatedEvent` → sentinel `(unknown — Junie)`. Older sessions
  (pre-`projectDir`) land in the sentinel bucket rather than a wrong project.
- **Timestamps** seeded from index `createdAt` (the leading turns are emitted
  before the first timestamped event); older sessions lack per-event timestamps
  and collapse to `createdAt` — acceptable, order is preserved by file order.
- **File edits feed the Files-changed tab.** `FileChangesBlockUpdatedEvent`
  carries full before/after content per file, so each change is emitted as a
  standard `Edit` block (`file_path` / `old_string` / `new_string`) — the exact
  shape the web changeset extractor (`pages/session/changeset.ts`) recognizes —
  giving Junie real per-file diffs and +/- counts. (Codex still can't: its
  rollouts lack structured before/after.) Other block kinds map to
  `terminal` / `view` / `tool` tool_use blocks.
- **Images included (v1):** string-path `customAttachments` (pasted clipboard
  PNGs) are base64-inlined as `ImageBlock`s at parse time (no file-serving route
  exists); typed/object attachments are skipped.
- **Tag color: green** (`#3FB950` / light `#1a7f37`), grassy to stay distinct
  from Codex's blue-leaning teal.

## Files affected

- `packages/server/src/connectors/junie/normalize.ts` — new. `parseSession` +
  `toCanonicalRows`.
- `packages/server/src/connectors/junie/junie.ts` — new. `AgentConnector` impl
  (discover via index.jsonl, prepare, projection, title aux, loadSession).
- `packages/server/src/config.ts` — `JUNIE_SESSIONS_DIR` (env-overridable).
- `packages/server/src/connectors/registry.ts` — register `junieConnector`.
- `packages/web/src/components/AgentBadge.tsx` — `junie` → "Junie" label.
- `packages/web/src/pages/browse/browse.css` — green `.tv-agent--junie` (dark +
  light).
- `packages/server/test/junie.integration.test.ts` — new synthetic-fixture suite.
- `packages/server/test/{api,codex}.integration.test.ts` — isolate
  `JUNIE_SESSIONS_DIR` to a temp dir so they don't read the real `~/.junie`.

No schema, shared-type, route, indexing, FTS, or thread-assembler changes — the
seam carried it.

## Testing

- `npm run typecheck` + `npm test` (83 tests) green.
- New suite asserts: junie agent tag, taskName title, projectDir→display name,
  summed tokens + haiku-family cost, FTS hit on a tool label, stepId coalescing
  into paired tool/result, ResultBlock final text, noise dropped, and a pasted
  PNG inlined as a base64 image block.
- Manual: built and ran against real `~/.junie` (isolated temp index) — 5
  sessions indexed with correct tokens/cost/titles, project grouping, analytics-
  by-agent, and a thread of paired tool/view blocks + result text.

## Risks / open questions

- Junie's `events.jsonl` schema is undocumented and may shift between versions;
  the kind→block mapping is centralized in `normalize.ts` and tolerates unknown
  kinds by skipping them.
- Transcripts read differently from Claude/Codex (block-and-result, no narrative
  prose, empty thinking) — expected, noted in `CLAUDE.md` gotchas.
- Some Junie models (non-Claude providers) may be absent from `pricing.json` →
  cost 0 for those events until rates are added.
