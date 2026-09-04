# 0083 — Context size and compaction count per session

- **Status:** done
- **Date:** 2026-09-04
- **PR:** [#107](https://github.com/vladar107/claudescope/pull/107)

## Context

Looking at [cctop](https://github.com/stefanprodan/cctop) for ideas, most of it
is live process monitoring, which does not fit a history tool. Its CTX column
does: context size is a property of the transcript, not of a running process,
and Claudescope already indexes the per-turn usage it is derived from. What the
history could not answer until now:

- how large the context was when a session stopped (does resuming it have room,
  or will the first thing it does be a compaction?);
- how many times a session was compacted, and where in the transcript;
- which sessions in a date range ran hot.

How the sources record a compaction, checked against real local data:

| Agent       | Marker                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Claude Code | `system` row, `subtype: "compact_boundary"`, `compactMetadata: {trigger, preTokens, postTokens}` (current); a `user` row flagged `isCompactSummary: true` (2025 format); mid-period files carry **both** for one compaction. Subagent files compact too. |
| Codex       | top-level `compacted` record (`payload.message` = plaintext summary, `replacement_history`); one compaction also writes an encrypted `compaction` response item and, in current versions, a `context_compacted` event — only `compacted` is counted. |
| pi          | `compaction` entry: `summary`, `tokensBefore`, `firstKeptEntryId`.                                   |
| Copilot     | `session.context_changed` event with `reason: "compaction"` (already in the fixture, previously skipped). |
| others      | opencode, Grok, Antigravity, Junie: no known marker → reported as unavailable, not 0.                |

Context at a turn = `input + cache_read + cache_write` on the assistant row (the
full prompt) — for connectors whose row IS one prompt (Claude Code, Codex, pi,
opencode). Copilot (session-level usage), Antigravity (none), and Junie/Grok
(one row sums a whole turn) do not get it.

## Goal

Every session shows its context size at the last main-thread turn (with a
percent of the model's window when known) and its compaction count; the
transcript shows a divider where each compaction happened; the efficiency table
sorts by both. No live machinery — everything comes from the index.

## Decisions

- **Context at the last turn, not the peak.** Without a compaction the two are
  the same number (context only grows within a segment). With compactions the
  peak is roughly the window edge for every session, which the compaction count
  already says — while "context now" is the actionable figure before resuming,
  and doubles as cctop's CTX for a session that is still running (meta is
  ≤15 s stale). The sawtooth stays visible in the transcript dividers.
- **Compactions live in their own aux table, not an events column.** Claude
  Code's marker is a `system` row, which `events` excludes by design (message
  counts, FTS, analytics all assume conversational rows). A file-keyed
  `compactions` table follows the `titles`/`pr_links` pattern; the canonical
  events contract (`CANONICAL_COLUMNS`) is untouched. Cache-backed connectors
  write `type: 'compaction'` rows into the NDJSON cache they already have; the
  events projection filters them out by type, a shared aux projection reads
  them back. Rejected: including system rows in `events` (changes its
  semantics for every consumer); per-event `is_compaction` (needs window
  functions over file order in the Claude Code projection).
- **Claude Code counts boundaries, falling back to flagged summaries** only in
  files with no boundary row, so the mid-period format is not double counted.
  The parser applies the same rule (one divider, merged).
- **Session count = main thread only.** A subagent compacting is visible in its
  own thread but would inflate the session's number confusingly.
- **One synthetic event shape for every agent.** Normalizers emit the Claude
  Code `system`/`compact_boundary` event (plus a `summary` field Claude Code
  does not have), so the parser has one path and pi summaries become readable
  in the transcript. Codex's `compacted.payload.message` is empty in every
  local sample, so Codex dividers usually carry sizes only (an empty summary
  is never emitted).
- **Divider numbers are derived when the agent does not record them.** Claude
  Code's `preTokens`/`postTokens` are used verbatim; otherwise the parser takes
  the previous and next assistant turns' prompt sizes — but only for agents
  with per-response usage (`assembleThread`'s `deriveContextSizes`, set by the
  route from the capability map). Copilot pins its session total to the last
  turn, so a derived "after" figure there would measure nothing.
- **Window size is best effort and resolved at read time.** `mapLiteLLM` keeps
  `max_input_tokens` as an optional `contextWindow` on `ModelRates`; the user
  `pricing.json` may set it on `models`/`families`; resolution is exact id →
  family → unknown, and the UI shows a percent only when known. Nothing about
  the window is stored in the index. Rejected: shipping family windows in the
  default `pricing.json` (Anthropic ids with 1M-context variants make a
  substring family wrong too often).
- **Capability map.** `data/agent-capabilities.ts` owns the per-connector
  usage granularity (moved from the comparison route), the compaction-signal
  set, and a separate **prompt-sized usage** set (Claude Code, Codex, pi,
  opencode) that gates the context figure: per-response granularity is not
  enough, because Junie sums every LLM call of an agentic loop into the turn's
  one row and Grok records one `turn_completed` total per user turn — a
  "context" read from either would routinely exceed the model's window. So
  `0` vs "unavailable" is decided in one place, never inferred from the data.
- **Schema v20** — forces a rebuild (derived cache).

## Approach

1. Shared contract: `SessionMeta.contextTokens/contextWindow/compactionCount`
   (optional = unavailable), `SessionSort 'context'`, efficiency row/sort/stats
   columns, `ThreadItem.compaction: CompactionInfo`, `SystemEvent.compactMetadata
   /summary`, `UserEvent.isCompactSummary`, `ModelRates.contextWindow`.
2. Index: `compactions` table + `sessions.context_tokens/context_model/
   compaction_count`; `AuxProjections.compactions` staged and swapped per file in
   `loadFile`; `rebuildSessions` derives the three columns (newest main-thread
   assistant row with a prompt, `row_number` with a `uuid` tie-break like
   `modal_cwd`; count of main-thread compaction rows).
   Claude Code aux SQL with the boundary-or-summary rule; `canonical.ts` gains
   `compactionRow`, `COMPACTION_ROW_TYPE`, `compactionsProjectionSql`, and the
   events projection's type filter.
3. Parser: stamp `compaction` on the first conversational item after a boundary
   (merge with a flagged summary turn), then fill missing pre/post from adjacent
   usage. Subagent runs go through the same path.
4. Normalizers: Codex (`compacted` → boundary with summary; skip the
   `compaction` item and `context_compacted`), pi (`compaction` entry →
   boundary with summary + `preTokens`), Copilot (`session.context_changed`
   reason `compaction` → boundary). Each connector's `auxProjections` returns the
   shared compactions projection.
5. Pricing: keep the window through refresh and sanitize; `contextWindowFor`.
6. Routes: session meta mapping gated by the capability map, `context` sort,
   efficiency columns/sorts/quantiles, CLI/MCP session header line.
7. Web: header (`142K context (71%)`, amber ≥ 80 %, red ≥ 95 %, tooltip with
   the definition and "N at last turn"), tier-two `⟲ N compactions`, list row
   `ctx` + compaction chip, sort option, transcript divider with the summary
   collapsible, efficiency columns.
8. Docs: CLAUDE.md gotcha, README feature line.

## Files affected

- `packages/shared/src/{api,events,thread,pricing}.ts` — contract (step 1).
- `packages/server/src/db/schema.ts` — v20, `compactions`, session columns.
- `packages/server/src/connectors/{canonical,types}.ts` — cache row + projection.
- `packages/server/src/data/agent-capabilities.ts` — new; `routes/analytics-agents.ts` imports it.
- `packages/server/src/data/index.ts` — aux staging/swap, rebuild aggregates.
- `packages/server/src/connectors/claude-code/claude-code.ts` — compactions aux SQL.
- `packages/server/src/connectors/{codex,pi,copilot}/{normalize,*}.ts` — synthetic boundary + wiring.
- `packages/server/src/data/parser.ts` — stamping + derivation.
- `packages/server/src/data/{pricing,pricing-refresh}.ts` — window.
- `packages/server/src/routes/{sessions,analytics-sessions}.ts`, `agent/shape.ts`.
- `packages/web/src/pages/session/{SessionPage,ThreadView}.tsx`, `session.css`,
  `pages/browse/SessionList.tsx`, `browse.css`, `pages/analytics/SessionEfficiencyTable.tsx`.
- `CLAUDE.md`, `README.md`, this plan.

## Testing

- `npm test`, `npm run typecheck`.
- Index: boundary-only file, boundary + flagged summary (counted once), flagged
  summary only, subagent boundary excluded from the session count, context =
  last turn with block-duplicated rows and a sidechain excluded, reload of one
  file replaces only its compaction rows.
- Normalizers: one compaction each for Codex/pi/Copilot → boundary event and
  cache row; the Codex `compaction` item stays out of the thread.
- Parser: stamp lands on the next item; merge with a flagged summary; derived
  pre/post from adjacent usage; no stamp when nothing follows.
- Pricing: `max_input_tokens` kept / invalid dropped without dropping the rates;
  user override wins; family fallback.
- Routes: Copilot session → no `contextTokens`; opencode session → no
  `compactionCount`; `sort=context`; efficiency columns and quantiles.

## Risks / open questions

- The Claude Code 2025 format is inferred from one local file; the rule is
  conservative (boundaries win) so a wrong guess under-counts, never doubles.
- The Codex `compaction` response item is only ever seen nested inside
  `compacted.replacement_history` locally, never as its own line; the explicit
  skip is forward-looking and covered by the fixture anyway.
- opencode very likely records compactions (an assistant `summary` message);
  add once verified against real data.
- Codex reports its own effective window (`model_context_window` on
  `token_count`, e.g. 258 400 for gpt-5.x-codex) which differs from LiteLLM's;
  a follow-up could prefer it.
- Per-turn context on every assistant turn was deliberately left out (noise).
