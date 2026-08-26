# 0075 — Reliable subagent linkage and Codex transcript rendering

- **Status:** done
- **Date:** 2026-08-26
- **PR:** https://github.com/vladar107/claudescope/pull/97

## Context

Real-data inspection found two related classes of subagent failure.

For Codex session `01a0386a-ee8b-7fa0-b5fc-3aaf702f4d3e`, ClaudeScope loads all
five child rollouts but gives none a `toolUseId`, so the UI lists them under
"Other subagents" instead of nesting them at their `Task` calls. The connector
expects the older `spawn_agent` result `{ agent_id }`; current rollouts return
`{ task_name: "/root/..." }`, while the child records the same value as
`session_meta.source.subagent.thread_spawn.agent_path`.

The same session also exposes a second Codex format change:
`custom_tool_call_output.payload.output` is now an array of text items rather
than always a string. The normalizer's string coercion turns those arrays into
an empty string, hiding real `exec` output and weakening rejected
`apply_patch` detection. A child rollout additionally begins with copied parent
AGENTS/environment/user context; preserving it is useful provenance, but
rendering the copied turn as ordinary subagent conversation is misleading.

Claude Code still links correctly in the local Claude Code 2.1.246 sample (all
7 runs in a representative session, and all 25 discovered child files had
sibling metadata). Its linkage is nevertheless fragile: the shared parser
matches the parent's `Agent`/`Task` description against
`agent-<id>.meta.json`. Missing, unreadable, or drifted metadata leaves a valid
child detached even though the parent's full `prompt` exactly matches the
child's first user message.

## Goal

Attach current and legacy Codex children deterministically, retain real
array-shaped tool results and patch failure semantics, provide a safe Claude
prompt fallback, and present copied Codex parent context as inherited metadata
rather than ordinary subagent dialogue.

## Decisions

- **Prefer explicit connector linkage over shared heuristics** — extend the
  internal `SubagentSource` contract with an optional spawning tool id. Codex
  can recover the exact call from `task_name`/`agent_path` (or legacy
  `agent_id`), so it should not depend on description equality. The shared
  description matcher remains for formats that expose no direct key.
- **Keep both Codex generations supported** — accept legacy `{ agent_id }` and
  current `{ task_name }` spawn results. Parse the child's canonical
  `agent_path` and preserve the parent call id in either case.
- **Use readable task metadata, not opaque payloads** — prefer plaintext
  `task_name` for the canonical `Task.description`. Retain a plaintext prompt
  when available, but do not render a long encrypted task payload as if it were
  a human-readable description; the raw rollout remains untouched.
- **Decode tool outputs at the format boundary** — one Codex helper accepts the
  legacy string and current text-item array shapes before envelope stripping or
  error detection. Known text items are concatenated in order; unfamiliar
  structured output degrades visibly rather than silently becoming empty.
- **Claude prompt matching is a guarded fallback** — expose the full first
  child prompt and compare it exactly with the spawning tool's `prompt` only
  after direct-id and description matching fail. After type narrowing, the
  prompt match must identify one unused spawn; no fuzzy text matching is
  introduced.
- **Collapse inherited context only in presentation** — a sidechain user turn
  beginning with a complete recognized Codex startup envelope renders as a
  collapsed "Inherited parent context" disclosure. Its exact blocks remain
  available on expansion and unchanged for source/index/export behavior.
- **Rebuild derived data once** — bump `SCHEMA_VERSION` from 15 to 16. Decoded
  tool results and correct rejected-patch demotion can change persisted tool
  errors/file edits, and unchanged source mtimes would otherwise retain stale
  normalized output.
- **No new dependencies** — reuse the connector JSON helpers, shared parser,
  existing context recognizer, and existing test suites.

## Approach

### Wave 1 — shared correlation and presentation

1. **Shared direct/prompt correlation** (Complex; no dependencies)
   - Add optional `toolUseId` and full `prompt` fields to `SubagentSource`.
   - Teach `buildSubagentRuns` to resolve an explicit tool id first, then keep
     Workflow correlation, description/type correlation, and finally exact
     prompt/type correlation.
   - Refactor the Claude connector's first-user-message extraction so the full
     prompt is available for matching while its first line remains the display
     fallback.
   - Acceptance: current Claude metadata-backed runs remain unchanged; a child
     with missing or mismatched metadata links only when its full prompt exactly
     matches one unused `Agent`/`Task` call; ambiguous/empty children remain
     detached.

2. **Inherited Codex context presentation** (Simple; no dependencies)
   - Extend the existing Codex startup-context helper with a fail-closed
     sidechain classification.
   - Render a matching sidechain user turn through the existing collapsed
     system-turn component as "Inherited parent context"; leave top-level
     session rendering unchanged.
   - Acceptance: the copied AGENTS/environment/original-prompt turn is compact
     but fully inspectable, while ordinary subagent user prose remains normal.

### Wave 2 — Codex format compatibility

3. **Deterministic current/legacy spawn linkage** (Complex; depends on task 1)
   - Parse `thread_spawn.agent_path` on child sessions.
   - Retain the spawning call id and index spawn metadata by legacy child id and
     current canonical task path.
   - Prefer `task_name` for the canonical Task label and pass the exact call id
     through `SubagentSource` when loading the child.
   - Acceptance: the five children in the affected session receive the correct
     `toolUseId`; the linked target nests under
     `call_Uw4zVlU3fj5jiGTQ3rZ5Wqya`; legacy `{ agent_id }` fixtures still link.

4. **String/array custom-tool results and patch correctness** (Complex;
   independent within Wave 2 but shares the Codex normalizer)
   - Normalize string and text-item-array outputs before pairing results.
   - Run success-envelope stripping and rejected-patch detection on the decoded
     text, preserving `is_error` and failed-edit demotion.
   - Keep successful multi-file per-file statuses and unknown-output fallback.
   - Acceptance: real `exec` output is visible; legacy string output is
     byte-equivalent; array-shaped successful and rejected patches produce the
     correct transcript and Files Changed result.

5. **Migration and connector documentation** (Simple; depends on tasks 3–4)
   - Bump the derived schema to v16.
   - Update the Codex/Claude subagent gotchas in `CLAUDE.md` with the supported
     linkage and output shapes.

### Wave 3 — integrated verification

6. Extend existing focused tests (no new test files) for direct tool-id
   correlation, Claude exact-prompt fallback, current Codex
   `task_name`/`agent_path`, array tool results, rejected array patch output,
   legacy compatibility, and inherited-context classification.
7. Run focused tests, full tests, typecheck, production build, and diff checks.
8. Use an isolated `CLAUDESCOPE_HOME` fixture run for end-to-end verification,
   then perform read-only checks against the supplied real session: correct
   nesting/hash navigation, non-empty tool results, compact inherited context,
   and accurate Files Changed output. Recheck a known-good Claude session to
   guard against correlation regressions.

## Files affected

- `packages/server/src/data/session-loader.ts` — optional exact spawn id and
  prompt signals on the internal subagent source contract.
- `packages/server/src/data/parser.ts` — direct-id-first correlation plus exact
  prompt fallback.
- `packages/server/src/connectors/claude-code/claude-code.ts` — retain the full
  first child prompt without changing its concise label.
- `packages/server/src/connectors/codex/normalize.ts` — current/legacy spawn
  metadata, readable Task mapping, agent path, and structured output decoding.
- `packages/server/src/connectors/codex/codex.ts` — resolve children by id or
  canonical task path and pass the exact spawning tool id.
- `packages/server/src/db/schema.ts` — schema v16 rebuild.
- `packages/web/src/pages/session/text.ts` — fail-closed inherited-context
  classification.
- `packages/web/src/pages/session/ThreadView.tsx` — collapsed inherited-context
  rendering for sidechain turns.
- `packages/server/test/parser.test.ts` — shared direct/prompt correlation.
- `packages/server/test/codex.integration.test.ts` — current and legacy Codex
  formats, tool output, and patch regression cases.
- `packages/server/test/api.integration.test.ts` — Claude missing/drifted-meta
  prompt fallback through the session API, if the parser-level case does not
  provide sufficient connector coverage.
- `packages/web/test/text.test.ts` — inherited-context classification edges.
- `CLAUDE.md` — connector gotcha updates.
- `docs/plans/README.md` — plan index entry.

## Testing

- Focused:
  `npx vitest run packages/server/test/parser.test.ts packages/server/test/codex.integration.test.ts packages/server/test/api.integration.test.ts packages/web/test/text.test.ts`
- Full: `npm test`
- Types: `npm run typecheck`
- Production build: `npm run build`
- Hygiene: `git diff --check`
- End-to-end: run the repository's `verify` skill against sandboxed fixtures;
  never point fixture validation at real agent sources or `~/.claudescope`.
- Read-only real-data checks for session
  `01a0386a-ee8b-7fa0-b5fc-3aaf702f4d3e` and a known-good Claude session after
  the isolated suite passes.

## Risks / open questions

- Upstream transcript formats are undocumented and best-effort. Unknown future
  output items must remain visible/raw rather than throwing or disappearing.
- Exact prompt fallback can still be ambiguous when two agents receive
  identical prompts. Type narrowing limits this, and a non-unique fallback must
  remain visibly unlinked rather than guessing by order.
- Collapsing inherited context must require both `isSidechain` and a complete
  recognized Codex envelope so genuine user prose is not hidden.
- A v16 rebuild can take time on large histories, but the DuckDB index and
  normalized cache are derived and user settings remain untouched.
- Recursive nesting of subagents spawned by subagents is not part of this
  change; this plan fixes attachment to the currently supported parent Task
  model.
- Decrypting Codex reasoning/task payloads and parsing arbitrary JavaScript
  inside the `exec` tool are explicitly out of scope. Empty thinking and raw
  JavaScript tool inputs remain expected where Codex stores no readable form.
