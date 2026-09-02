# 0079 — Literal search and tool/skill analytics

- **Status:** done
- **Date:** 2026-09-02
- **PR:** https://github.com/vladar107/claudescope/pull/102

## Context

Second half of issue
[#100](https://github.com/vladar107/claudescope/issues/100) (first half: plan
0078). When an agent does consult history for an error message or identifier,
BM25 is the wrong tool: two of the three sessions that used the skill abandoned
`search` for grep because ranking returned noise. Worse, the index stores only
`text` / `thinking` blocks, so a tool error that the assistant never restated is
unfindable by any search. Measuring skill adoption today means dumping every
session and post-processing with jq, because `tool_use.input` is never
persisted and `tool_names` only says `Skill`.

## Goal

`search --literal` finds exact strings across transcript text, failed tool
results, tool names and skill names; `analytics --group-by tool|skill` answers
"how often was X used" in one command. Default search ranking is untouched
(issue non-goal).

## Decisions

- **Schema v19 with two narrow columns** — `tool_error_text` (failed
  `tool_result` bodies only, capped per event) and `skill_names` (CSV of the
  `skill` argument on canonical `Skill` calls, shaped like `tool_names`).
  Indexing all tool-result bodies was rejected: file reads would bloat the
  index for little search value. FTS stays on `text_content` only.
- **Literal mode is a filter, not a ranking** — `contains(lower(col), lower(q))`
  over the four columns, newest first, same 50 cap and the same snippet
  renderer (already plain substring). No change to the BM25 path or its
  identifier heuristic.
- **Tool/skill grouping reuses the tools endpoint** — `/api/analytics/tools`
  gains `kind=tool|skill`; the CLI's `analytics --group-by tool|skill` routes
  there and prints `KEY, AGENT, COUNT`. Extending the token analytics route was
  rejected: one event carries several tool calls, so token sums per tool would
  double-count.
- **Call counts exclude fork copies, not non-canonical rows** — review fix.
  `usage_canonical` elects ONE row per billed `message.id` for token sums, but
  tool_use blocks sit on whichever row carries them. Measured over 38 real Claude
  Code transcripts: 1022 of 1451 message ids span several rows with identical
  usage (the election falls to the uuid tiebreak), leaving 876 of 1312 tool-call
  rows and 9 of 15 Skill rows on a non-elected row and invisible to this
  endpoint. The filter is therefore `forked_from_session_id IS NULL` — the same
  fork exclusion `routes/analytics-errors.ts` uses, and the marker sits on every
  copied row, so a fork still cannot double-count. The web's tool-usage chart
  reads the same endpoint and now shows the corrected, higher counts.
- **`skill_names` is best-effort per connector** — populated where a canonical
  `Skill` tool_use exists (Claude Code, Grok); Codex injects skills as message
  content, not tool calls, and stays empty.

## Approach

1. Index derivation (schema v19): columns in `schema.ts` + changelog; the
   Claude Code lateral pass derives both (string vs text-block-array
   `tool_result` content); `connectors/tool-errors.ts` gains `toolErrorText`,
   new `connectors/skill-names.ts`; `CANONICAL_COLUMNS` /
   `canonicalProjectionSql`; every cache-backed normalizer emits the two
   fields; staging list in `data/index.ts`.
2. Tools endpoint `kind` param; `ApiClient.toolUsage`; CLI
   `analytics --group-by tool|skill` (+ `--project`); MCP `get_analytics`
   values.
3. `search --literal`: `SearchQuery.literal`, route branch, CLI flag, MCP
   param.
4. Docs: this plan, README scripting section, SKILL.md (`--literal` for errors
   and identifiers).
5. Review, tests, typecheck, build.

## Files affected

- `packages/server/src/db/schema.ts` — v19, two columns.
- `packages/server/src/connectors/claude-code/claude-code.ts` — lateral
  derivation.
- `packages/server/src/connectors/tool-errors.ts`,
  `connectors/skill-names.ts` (new), `connectors/canonical.ts`, each
  `connectors/*/normalize.ts`.
- `packages/server/src/data/index.ts` — staging columns.
- `packages/server/src/routes/search.ts` — literal branch.
- `packages/server/src/routes/analytics-tools.ts` — `kind`.
- `packages/shared/src/api.ts` — `SearchQuery.literal`, tool-usage query kind.
- `packages/server/src/agent/{query,api-client,mcp}.ts`, `cli.ts`.
- `README.md`, `plugins/claudescope/skills/history/SKILL.md`,
  `docs/plans/README.md`.
- Tests: literal search integration (punctuation string BM25 loses; hit only in
  `tool_error_text`; empty wording), tools endpoint `kind=skill`, Claude Code
  array-form error result, one normalizer's `tool_error_text`.

## Testing

`npm test`, `npm run typecheck`, `npm run build`; the schema bump is covered by
the existing stale-signature rebuild test.

## Risks / open questions

- The schema bump forces a full rebuild on upgrade (routine; v18 did the same).
- `tool_error_text` is verbatim transcript data like `text_content`; `--redact`
  applies to session output, not search snippets, as today.
- Rebase onto plan 0078's branch: both touch `api.ts`, `cli.ts`, `mcp.ts`,
  `SKILL.md`, and the plans index — small, mechanical conflicts.
