# 0072 — Hide Codex guardian sessions

- **Status:** done
- **Date:** 2026-08-18
- **PR:** pending

## Context

Recent Codex versions persist internal approval-review conversations as separate
rollouts with `thread_source: "subagent"` and
`source.subagent.other: "guardian"`. Unlike user-spawned subagents, these
rollouts have no `thread_spawn` linkage. ClaudeScope currently falls through to
normal-session handling, so each guardian appears as a top-level session whose
synthetic transcript history is rendered as a large user message.

The other connectors use agent-specific linkage (nested paths, parent session
ids, inline agent ids, or explicit spawn records) and do not consume Codex
rollouts, so this schema and failure mode are Codex-specific.

## Goal

Exclude Codex guardian approval-review rollouts from indexing while preserving
normal top-level Codex sessions, linked spawned subagents, and orphan handling
for spawned subagents whose parent rollout is missing.

## Decisions

- **Filter by the explicit guardian source marker** —
  `source.subagent.other: "guardian"` is the stable structural distinction in
  the observed rollout metadata. Content matching would be brittle and could
  hide legitimate user text.
- **Filter during normalization** — returning no canonical rows prevents the
  internal rollout from entering session lists, search, analytics, or detail
  views while retaining ordinary source discovery and cache pruning behavior.
- **Bump the index schema version** — source mtimes do not change on upgrade, so
  existing derived indexes must rebuild once to remove guardian rows indexed by
  earlier ClaudeScope versions.
- **Keep the change Codex-only** — no other connector recognizes this source
  schema, and the repository audit found no equivalent fallback requiring a
  shared abstraction.

## Approach

1. Detect the guardian marker immediately after reading Codex `session_meta`.
2. Skip normalization for guardian rollouts without changing normal spawned or
   orphaned-subagent behavior.
3. Bump the derived-index schema version so existing installations rebuild.
4. Rebuild an isolated local index from the real transcript set and verify the
   reported guardian session disappears while its reviewed user session remains.
5. Run the existing test and typecheck suites, then review the final diff.

## Files affected

- `packages/server/src/connectors/codex/normalize.ts` — identify and skip Codex
  guardian rollouts.
- `packages/server/src/db/schema.ts` — invalidate existing derived indexes so
  previously indexed guardian rows are removed on upgrade.
- `docs/plans/0072-hide-codex-guardian-sessions.md` — record the scoped plan and
  evidence.
- `docs/plans/README.md` — index this plan.

## Testing

- `npm test`
- `npm run typecheck`
- Isolated real-data reindex: confirm guardian IDs are absent from session APIs
  and their parent user sessions remain present.

## Risks / open questions

- Codex may add other `source.subagent.other` roles later. This fix intentionally
  matches only `guardian`; unknown roles remain visible until their semantics are
  understood rather than being silently discarded.
- Repository and real-data audits found no equivalent internal-session schema in
  the other supported connectors, so no cross-connector change is needed.
