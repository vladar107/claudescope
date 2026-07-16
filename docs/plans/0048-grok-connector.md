# 0048 — xAI Grok CLI connector

- **Status:** done
- **Date:** 2026-07-16
- **PR:** https://github.com/vladar107/claudescope/pull/65

## Context

Claudescope merges coding-agent transcripts from 7 sources into one viewer. The
xAI Grok CLI (`grok`, probed at v0.2.101) stores sessions under
`~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/` and was not supported.
Scope is **xAI Grok only** (not other "grok"-named tools).

The on-disk format (verified against real local sessions, including a real
parent+subagent pair, plus a scratch probe session for the edit tools):

- **`chat_history.jsonl`** — message spine, OpenAI-Responses style rows:
  `system` (string), `user` (content parts: `text` | `image` with an inline
  base64 data-URL; real prompts carry `prompt_index` and `<user_query>`-wrapped
  text; injected context rows — user_info, agents-md, system-reminders — have
  no `prompt_index`), `reasoning` (**plaintext** `summary[].text` + opaque
  `encrypted_content`), `assistant` (markdown string, `model_id`,
  `tool_calls[]` with JSON-string `arguments`), `tool_result`
  (`{tool_call_id, content}`, no error flag). No timestamps, no usage.
- **`updates.jsonl`** — ACP-style overlay: per-event `agentTimestampMs`;
  `tool_call` correlates by `toolCallId`; `turn_completed` carries the only
  usage (`inputTokens`, `outputTokens`, `cachedReadTokens` — a **subset** of
  input — `reasoningTokens` inside output). May be missing/truncated.
- **`summary.json`** — `info.{id, cwd}` (plain cwd), ISO
  `created_at`/`updated_at`, `generated_title`, `session_kind: "subagent"`.
- **Subagents** — children are sibling top-level session dirs; the only
  linkage is the parent's `subagents/<child-id>/meta.json`
  (`subagent_type`, `description`, `prompt`). The parent spawns via
  `spawn_subagent {description, prompt}`.
- Edit tools (confirmed via probe): `write {file_path, content}`,
  `search_replace {file_path, old_string, new_string}`.
- Resume: `grok --resume <id>` (+ `--fork-session` to fork).
- Memory: `~/.grok/memory/` — experimental, off by default.

## Goal

Grok sessions browse/read/search/cost like every other agent: badge + title in
the list, threaded detail with rendered reasoning and Files-changed, subagents
nested at their spawning call, per-turn tokens priced at real grok rates.

## Decisions

- **prepare() → canonical NDJSON** (pi/copilot pattern) — the three-file split
  can't be projected per-row by DuckDB. Cache at `~/.claudescope/cache/grok/`.
- **chat_history is the spine; updates.jsonl is a best-effort overlay** —
  timestamps assign by a monotonic carry-forward walk (user prompt k anchors to
  turn k's start, assistant rows to their earliest `tool_call` update, a final
  no-tools assistant to the turn's end; everything else inherits, clamped
  monotonic, seeded/fallback from `summary.json` times). A corrupt/missing
  updates file degrades to summary timestamps and zero usage — never an error.
- **Usage split**: `input_tokens = inputTokens − cachedReadTokens` (verified
  subset relationship), attached once to each turn's last assistant row; NULL
  `message_id` → every row usage-canonical (no dedup needed).
- **Skip injected rows** (user rows without `prompt_index`, the system row) —
  they'd render fake user bubbles and pollute FTS; strip the `<user_query>`
  wrapper so titles/search show what the user typed.
- **Subagent re-key via readdir scan** of sibling dirs' `subagents/` folders
  (memoized per cwd-dir mtime) — the child carries no parent pointer. Children
  emit `session_id = parent`, `is_sidechain: true`; `spawn_subagent` → `Task`
  with `subagent_type` from meta.json matched by the shared `description`.
  Orphans (no meta claims them) index standalone.
- **Folded freshness**: discovery/statFile fold mtime/size of all three files —
  usage and title are written after the last chat row, so chat mtime alone
  would miss them.
- **Pricing shipped, not fetched**: LiteLLM has no bare `grok-*` keys (all
  `xai/`-prefixed, which `mapLiteLLM` skips), so shipped exact entries
  (`grok-4.5`, `grok-4`, `grok-code-fast-1`) + a `grok` family carry the cost
  path; `PRICING_SCHEMA_VERSION` bumped 3 → 4 to reconcile user copies.
- **No memory in v1** — Grok memory is experimental and off by default;
  follow-up if it graduates.

## Approach

1. Probe a scratch grok session to confirm `write`/`search_replace` arg shapes
   (then delete it). Confirmed: 1:1 with canonical `Write`/`Edit`.
2. `config.ts`: `GROK_SESSIONS_DIR`; pricing entries + schema bump.
3. `connectors/grok/normalize.ts`: tolerant parser, updates overlay, tool
   canonicalization, usage split, title threading.
4. `connectors/grok/grok.ts`: discover/statFile (folded), prepare/cache,
   projections (copilot shape), loadSession subagent attach, resumeSpec.
5. Registry + web badge/CSS + analytics-agents granularity/notes.
6. `test/grok.integration.test.ts` + `GROK_SESSIONS_DIR` isolation in all
   existing integration tests (antigravity precedent).
7. Docs: CLAUDE.md source list/gotchas/thinking exceptions, README.

## Files affected

- `packages/server/src/connectors/grok/{grok,normalize}.ts` — new connector.
- `packages/server/src/connectors/registry.ts` — register it.
- `packages/server/src/config.ts` — `GROK_SESSIONS_DIR`; schema version bump.
- `packages/server/pricing.json` — grok family + exact model rates.
- `packages/server/src/routes/analytics-agents.ts` — granularity + note.
- `packages/web/src/components/AgentBadge.tsx`, `packages/web/src/pages/browse/browse.css` — badge label + neutral-slate chip colors.
- `packages/server/test/grok.integration.test.ts` — new suite; all existing
  integration tests gain the `GROK_SESSIONS_DIR` isolation line;
  `memory-overview.test.ts` expects the new connector card.
- `CLAUDE.md`, `README.md` — source lists, gotchas, env var docs.

## Testing

- `npm test` (441 tests) and `npm run typecheck` green.
- Integration suite covers the weird stuff: sibling-dir subagent re-key +
  `Task` nesting + tokens folded into the parent, orphan child standalone,
  the input-minus-cachedRead split priced at the shipped `grok-4.5` rate
  (proving family/model resolution), `search_replace`→`Edit` in the shape the
  Files-changed extractor keys off, inline data-URL → ImageBlock (malformed
  URL tolerated), plaintext reasoning rendered, injected rows excluded from
  thread AND search, `<user_query>` strip feeding the fallback title, missing
  `updates.jsonl` (zero usage, summary timestamps), corrupt trailing line.
- Manual run against the real `~/.grok/sessions` with a throwaway
  `CLAUDESCOPE_HOME`/`DUCKDB_PATH` and all other sources pointed at empty dirs.

## Risks / open questions

- Grok is pre-1.0; the three-file format may drift (the tolerant parser skips
  unknown row/update types, so drift degrades rather than breaks).
- `tool_error_count` is NULL — `tool_result` carries no error flag; deriving
  errors from `tool_call_update.status` is a possible follow-up.
- Memory (`~/.grok/memory/`) not surfaced; revisit if it leaves experimental.
- LiteLLM rates for grok never overlay (prefix-keyed) — shipped rates must be
  maintained by hand when xAI changes pricing.
- `grok --fork-session` semantics are unverified: if a fork copies the source
  session's `updates.jsonl` (with its `turn_completed` usage) into a new
  session dir, the copied turns would double-count cost (grok rows have no
  `message_id` to dedup on). Verify if forked grok sessions appear.
- Nesting is one level (like pi): a subagent spawning a subagent would index
  under its immediate parent's id, not the root. Grok's default agents can't
  spawn nested subagents, so this shouldn't occur in practice.
