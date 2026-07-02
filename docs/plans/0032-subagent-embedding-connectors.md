# 0032 — Subagent embedding for Codex, pi, opencode, Copilot

- **Status:** done
- **Date:** 2026-07-02
- **PR:** https://github.com/vladar107/claudescope/pull/45

## Context

Only Claude Code and Antigravity nest subagent runs under their parent session.
The other connectors either double-list children as independent top-level
sessions (Codex separate rollouts, pi nested run transcripts, opencode child
session rows) or flatten them into the main thread (Copilot inline events).
Codex additionally drops `custom_tool_call` records entirely, so `apply_patch`
edits are invisible in the transcript and the Files-changed tab.

Inspection of real session data (2026-07-02) established every source records
enough linkage to embed:

- **Codex**: child rollouts carry `session_meta.thread_source: "subagent"` +
  `source.subagent.thread_spawn.{parent_thread_id, agent_nickname, agent_role}`;
  the parent records `spawn_agent` (output: `{agent_id}`) / `wait_agent` /
  `close_agent` calls. `apply_patch` arrives as `custom_tool_call` (not
  `function_call`).
- **pi**: a `subagent` toolCall `{agent, task}`; the toolResult carries
  `details.{mode, runId, results[]}`; the child transcript lives at
  `<sessionBasename>/<runId>/run-N/session.jsonl`.
- **opencode**: child sessions have `session.parent_id`; the parent's `task`
  tool part has `input.{description, prompt, subagent_type}` and
  `state.metadata.sessionId` = the child id.
- **Copilot**: the subagent's whole event stream is inline in the parent's
  `events.jsonl` between `subagent.started`/`subagent.completed`, every inner
  event tagged with `agentId` (= the spawning `task` toolCallId).
- **Junie**: no linkage exists — its "subagents" are plain `junie` CLI
  subprocesses launched from terminal commands; children are independent
  sessions by design. Documented, not embedded.

## Goal

Codex/pi/opencode subagent transcripts fold into their parent session (list,
search, tokens) and render nested at their spawn point; Copilot subagent turns
are segmented out of the main thread and nested; Codex `apply_patch` edits
render as canonical `Write`/`Edit` blocks and populate the Files-changed tab.

## Decisions

- **Antigravity pattern everywhere** — child canonical rows are re-keyed to the
  root session id with `is_sidechain = true`; the indexer, parser, API, and web
  UI need no changes (session grouping is purely `files.session_id`; nesting
  correlates a `SubagentSource.description` to a canonical `Task` block's
  `input.description`). Rejected: teaching the indexer about parent links —
  the connector seam already carries everything.
- **Synthesize canonical `Task` blocks in each normalizer** (`spawn_agent`,
  pi `subagent`, opencode `task`, Copilot `task`), `description` derived
  identically on both the Task-block side and the `SubagentSource` side so
  `buildSubagentRuns` anchors runs deterministically.
- **Codex `apply_patch` → per-file `Write`/`Edit`/`MultiEdit`**, mirroring the
  opencode connector's existing mapping, so `changeset.ts` keys off it.
- **One `SCHEMA_VERSION` bump** (8 → 9) forces existing indexes to rebuild so
  already-indexed child sessions re-key under their parents.
- **Junie: docs only** — matching terminal-command text to session prompts
  would be heuristic and fragile; not worth it.

## Approach

1. Codex: parse `custom_tool_call`/`custom_tool_call_output` (+ tool/web
   search records), map `apply_patch`; re-key subagent rollouts via a cached
   id→parent map from `session_meta` scans; `spawn_agent` → `Task`;
   `loadSession` splits parent/children.
2. pi: re-key nested `run-N/session.jsonl` by path shape; `subagent` toolCall →
   `Task` (management calls stay passthrough); capture `toolResult.details`;
   `loadSession` attaches per-result run transcripts.
3. opencode: expose `parent_id`; re-key children to the root ancestor
   (cycle-guarded); `task` part → `Task`; `loadSession` reads children via
   `readSession`, correlated by `state.metadata.sessionId`.
4. Copilot: segment events by `agentId` into per-subagent buffers
   (`is_sidechain = true` in canonical rows); `task` toolRequest → `Task`;
   metadata from `subagent.started`; migrate its image resolver to the shared
   `safe-image.ts` helper (plan 0033).
5. Bump `SCHEMA_VERSION`; update CLAUDE.md gotchas (incl. Junie's by-design
   non-linkage).

## Files affected

- `packages/server/src/connectors/codex/{normalize,codex}.ts` — custom tool
  records, apply_patch, subagent re-keying and loading.
- `packages/server/src/connectors/pi/{normalize,pi}.ts` — child re-keying,
  Task mapping, run attachment.
- `packages/server/src/connectors/opencode/{normalize,opencode,db}.ts` —
  parent_id plumbing, Task mapping, child loading.
- `packages/server/src/connectors/copilot/{normalize,copilot}.ts` — agentId
  segmentation, Task mapping, safe-image migration.
- `packages/server/src/db/schema.ts` — SCHEMA_VERSION 9.
- `packages/server/test/{codex,pi,opencode,copilot}.integration.test.ts` —
  embedding fixtures and assertions.
- `CLAUDE.md` — per-connector gotcha updates.

## Testing

`npm test` and `npm run typecheck`. Per connector: child folds into the parent
session (never listed top-level), `hasSidechain` set, `detail.subagents`
anchored to the `Task` block via `toolUseId`, child text searchable under the
parent, orphan/missing-parent fallbacks don't crash indexing. Codex:
`apply_patch` produces canonical blocks with `file_path`; result envelopes
stripped. Copilot: main thread free of subagent turns.

## Risks / open questions

- Codex/pi child token usage now counts toward the parent session (matches
  Claude Code semantics; Copilot unchanged — tokens are session-level).
- pi parallel subagent runs (`run-1+`) are inferred from `details.results`
  order; only single-run fixtures exist today.
- Copilot nested (subagent-spawned) subagents: no real-world sample; segmenter
  should tolerate unknown `agentId`s rather than crash.
