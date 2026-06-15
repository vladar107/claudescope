# 0019 — pi connector

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-15
- **PR:** https://github.com/vladar107/claudescope/pull/22

## Context

[pi](https://pi.dev) (v0.79.4, `@earendil-works/pi-coding-agent` — Mario
Zechner's minimal terminal coding harness, backed here by the `openai-codex`
provider) writes transcripts to `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`
— one JSONL per session, grouped per working directory, exactly like Claude Code
and Codex.
Adding it is a new `AgentConnector`; the index/FTS/cost/derived paths stay shared
(see `0004-connector-seam.md`, `0005-codex-connector.md`).

The format is **threaded JSONL very close to Claude Code**, but two session-level
facts are spread across record types, so it needs a Codex-style `prepare()`
normalizer rather than a per-row DuckDB projection.

Record shape (verified against the two real sessions on disk):

- `{type:"session", version, id, timestamp, cwd}` — **cwd lives here only**.
- `{type:"model_change", provider, modelId}` — model selection records.
- `{type:"thinking_level_change", thinkingLevel}` — reasoning-effort records.
- `{type:"message", id, parentId, timestamp, message:{role, content[], model,
  provider, usage}}` — the conversation. `message.usage` is camelCase
  `{input, output, cacheRead, cacheWrite, totalTokens, cost}` on assistant turns.
- content blocks: `text`, `thinking` (**plaintext** in `.thinking`, plus an
  encrypted `thinkingSignature`), `toolCall {id, name, arguments}`, and a
  separate `toolResult {toolCallId, toolName, content[]}` record.

## Goal

pi sessions are indexed, browsable, searchable, costed, and render with text,
**plaintext thinking**, tool calls, and tool results — merged into the per-`cwd`
project view and tagged with a `pi` agent badge.

## Decisions

- **`prepare()`-based normalizer (Codex pattern), not a per-row projection** —
  `cwd` is only on the `session` line and must be broadcast to every event; a TS
  pre-pass is the established way (`codex/normalize.ts`). Output a canonical
  NDJSON to `~/.claudescope/cache/pi/<sha1(path)>.ndjson`; the projection reads it
  1:1 with the same column map Codex/Junie use.
- **Model/provider taken per-turn from `message.model`/`message.provider`; ignore
  `model_change` for attribution** — verified every assistant turn self-reports
  its model, so we sidestep mid-session-switch and branching concerns. Only `cwd`
  is carried forward (from the `session` line).
- **Synthesize a fresh sequential `uuid`/`parentUuid` chain over message rows
  only** (`<sessionId>-<seq++>`, `prevUuid → next`) — pi's native `parentId`
  graph threads *through* `model_change`/`thinking_level_change` records (the
  first user turn's `parentId` points at a `thinking_level_change` id), so copying
  it verbatim would dangle. Matches `codex/normalize.ts`.
- **Thinking is PLAINTEXT — map `block.thinking → ThinkingBlock.thinking`, do NOT
  blank it**, and carry `thinkingSignature → ThinkingBlock.signature`. This is the
  one place pi diverges from the "thinking renders empty" gotcha (Claude/Codex
  store only a signature). A connector that blanked it would silently drop
  readable reasoning pi actually preserves.
- **Tool results ride a synthetic `user` event** (there is no `toolResult`
  RawEvent type), paired to their `tool_use` by the **verbatim composite id**
  (`call_…|fc_…`) — preserve the full id on both sides or pairing breaks.
- **Map pi's tool vocabulary to Claude's canonical names** (`edit`→`MultiEdit`,
  `write`→`Write`, `read`→`Read`, `bash`→`Bash`), translating input keys
  (`path`→`file_path`, `edits[].oldText/newText`→`old_string/new_string`). The web
  renderer (`ToolBlock`) and the **Files-changed tab** (`changeset.ts`) key off the
  Claude tool names + `file_path`; without this, pi edits never reach the
  Files-changed tab and tools render as raw JSON. Mirrors how the Junie connector
  emits canonical `Edit` blocks. Unknown tools pass through with their native name.
- **Preserve images / embed screenshots.** pi stores a pasted screenshot as
  `{type:'image', data, mimeType}` inside the `read` tool *result* (the user
  message only holds the temp-file path). Map it to the canonical
  `ImageBlock` (`source:{type:'base64', media_type, data}`) so `extractImage`
  renders it — the normalizer must keep image blocks, not just text. One small,
  Claude-safe web tweak: the `Read` renderer now uses `ResultSection` whenever the
  result has non-text blocks, so an image read shows the picture even when pi also
  includes a descriptive text block (previously the text suppressed the image).
- **`message_id = NULL`** (pi has no per-block id and no fork/resume) → every row
  is usage-canonical, no dedup logic. `forked_from_session_id = NULL`,
  `service_tier = NULL` (absent in pi), `git_branch = NULL` (not stored).
- **Token map (camelCase):** `input→input_tokens`, `output→output_tokens`,
  `cacheRead→cache_read_tokens`, `cacheWrite→cache_write_tokens`; user/toolResult
  rows get zero usage. pi's own `cost` is ignored — Claudescope recomputes from
  tokens × pricing, as for every connector.
- **No memory (decided: skip for both pi and opencode).** `~/.pi` holds only
  `settings.json`/`auth.json`; pi's instruction files are the project-local
  `CLAUDE.md`/`AGENTS.md`, out of scope under the read-only-home invariant. Per
  the maintainer decision, the connector implements **neither** `globalMemory()`
  **nor** `projectMemory()` (both omitted) — pi simply doesn't appear in the
  memory viewer.
- **Pricing landed with this work (already applied).** pi uses `gpt-5.4-mini`,
  which was missing from `pricing.json` and mis-resolved to the `gpt` family
  (2.5/15) — a ~3.3× overcharge. `pricing.json` was repopulated from OpenAI's
  official tables (June 2026): the full GPT‑5.x / GPT‑4.x / o‑series / Codex /
  ChatGPT lineup as exact‑id entries (short‑context rates), so exact‑id joins win
  over the order‑fragile family matching. This also **corrected two pre‑existing
  errors**: `gpt-5` was `0.625/5` (official `1.25/10`) and `gpt-5.4` cached was
  `0.5` (official `0.25`). `gpt-5.4-mini-fast` (opencode's id) is priced as
  `gpt-5.4-mini` — there is no official `-fast` SKU; it's opencode's service‑tier
  label. `PRICING_SCHEMA_VERSION` bumped `1 → 2` so existing user copies merge the
  new keys (user edits still win — so a user whose copy predates this keeps their
  old `gpt-5`/`gpt-5.4` values; fresh installs and the LiteLLM refresh get the
  corrected ones).

## Approach

1. `packages/server/src/config.ts` — add `PI_SESSIONS_DIR`
   (`~/.pi/agent/sessions`, env-overridable, `~`-expanded) and derived `PI_HOME`
   (= `dirname(dirname(PI_SESSIONS_DIR))` → `~/.pi`), mirroring the existing
   Claude/Codex/Junie constants.
2. `packages/server/src/connectors/pi/normalize.ts` — parse one session JSONL into
   Claude-shaped `RawEvent[]` (cwd from the session line; synthesized uuid chain;
   plaintext thinking; tool_use on assistant turns; tool_result on a following
   user turn paired by composite id) and `toCanonicalRows()` → the canonical NDJSON
   rows. Tolerate blank/corrupt lines and unknown record types.
3. `packages/server/src/connectors/pi/pi.ts` — the `AgentConnector`: `discover()`
   (walk the sessions tree, real path as the key), `prepare()` (write the cache
   NDJSON), `eventsProjectionSql()` (read the cache, identical shape to Codex),
   `auxProjections()` → `{}` (no titles/PR links; first-user-message title
   fallback applies), `loadSession()` (re-run the normalizer → `{mainEvents,
   subagents: []}`). No `globalMemory`/`projectMemory` (memory skipped).
4. `packages/server/src/connectors/registry.ts` — register `piConnector`.
5. **Pricing** — ✅ done. `packages/server/pricing.json` repopulated from
   OpenAI's official tables (full GPT‑5.x/4.x/o‑series/Codex lineup as exact‑ids,
   short‑context rates), incl. `gpt-5.4-mini` + `gpt-5.4-mini-fast`; corrected
   `gpt-5`/`gpt-5.4`; `PRICING_SCHEMA_VERSION` bumped to 2 in `config.ts`.
6. **Web** — `packages/web/src/components/AgentBadge.tsx` add `'pi' → 'pi'`;
   `packages/web/src/pages/browse/browse.css` add `.tv-agent--pi` colors
   (dark + light).
7. **Docs** — `README.md` supported-agents + env-var tables; `CLAUDE.md` gotchas
   ("pi thinking renders plaintext, unlike Claude/Codex").

## Files affected

- `packages/server/src/config.ts` — `PI_SESSIONS_DIR` + `PI_HOME`.
- `packages/server/src/connectors/pi/{normalize,pi}.ts` — new connector (+ memory
  is intentionally empty, so no `memory.ts`).
- `packages/server/src/connectors/registry.ts` — register.
- `packages/server/pricing.json` + `config.ts` `PRICING_SCHEMA_VERSION` — gpt-5.4
  family rates.
- `packages/server/src/data/index.ts` — build the pricing join table lazily (only
  on the first file load) so a no-op reindex does no pricing work. Avoids a perf
  regression from the now-larger pricing table on the 15s auto-poll.
- `packages/web/src/components/AgentBadge.tsx`, `pages/browse/browse.css` — label
  + badge color.
- `packages/web/src/components/ToolBlock.tsx` — `Read` renderer shows image
  results even when descriptive text is present (Claude-safe; fixes pi screenshots).
- `packages/server/test/pi.integration.test.ts` — new suite (fixtures in a temp
  dir; never touches real `~/.pi`). Add `PI_SESSIONS_DIR` isolation to the other
  integration/pricing/dedup/recovery suites.
- `README.md`, `CLAUDE.md`, `docs/plans/README.md` (index row).

## Testing

`npm run typecheck` + `npm test`. New integration fixtures target the weird stuff
(per `CLAUDE.md` test guidance), not happy-path glue:

- **cwd broadcast** — every event gets the session-line `cwd` (project grouping).
- **plaintext thinking survives** — a `thinking` block's text reaches
  `text_content`/the rendered thread (regression guard for the blank-thinking trap).
- **tool_use ↔ tool_result pairing** by composite `call_…|fc_…` id, including a
  fan-out turn with multiple tool calls.
- **dangling-parent avoidance** — first user turn whose native `parentId` points at
  a `thinking_level_change` record still threads (synthesized chain).
- **cost** — a `gpt-5.4-mini` assistant turn costs `tokens × 0.75/4.50/0.075`, not
  the `gpt`-family 2.5/15.
- **malformed/truncated trailing line** is skipped, not fatal.

## Risks / open questions

- **`gpt-5.4-mini-fast` premium tier** — we price it as standard `gpt-5.4-mini`.
  OpenAI's priority/"fast" processing can cost ~2× standard; opencode's `-fast`
  suffix (see `0020`) may or may not map to priority billing. Pricing is a local
  estimate; confirm with the user / adjust the exact-id rate if they're on priority.
- **Older pi schema versions** — discovered files are `version: 3`; guard the
  `prepare()` pass for hypothetical v1/v2 (not observed) instead of assuming the v3
  shape.
- **`thinkingSignature` is JSON-wrapped** (an OpenAI Responses reasoning blob),
  unlike Claude's opaque signature — store as-is; it is render-irrelevant.
