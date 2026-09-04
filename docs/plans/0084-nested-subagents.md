# 0084 — Nested subagents (a subagent spawning a subagent)

- **Status:** done
- **Date:** 2026-09-04
- **PR:** [#108](https://github.com/vladar107/claudescope/pull/108)

## Context

Claude Code lets a subagent call the `Agent` tool. Verified with a real
depth-2 spawn: the grandchild is a **sibling** file in the same
`<session>/subagents/` directory (no nested folder); its
`agent-<id>.meta.json` carries `toolUseId` (the `Agent` call inside the
depth-1 child's transcript), `parentAgentId`, and `spawnDepth: 2`; the rows
themselves only carry their own `agentId`.

What Claudescope did with it:

- the loader read only `agentType`/`description` from the metadata, so even
  the exact spawning id was ignored (Codex was the only connector ever setting
  `SubagentSource.toolUseId`);
- `buildSubagentRuns` collected spawn points from the **main thread only**,
  so a call living in a run's thread could never match — the grandchild landed
  in the "Other subagents" section, and with a description equal to an unused
  main-thread call it would have nested under the **wrong** call;
- `subagentsInWindow` dropped unlinked runs, so windowed reads (MCP
  `get_session`, the CLI, the web's paged loading) lost the grandchild;
- `SubagentBlock` rendered its thread without the run map, so nothing could
  recurse even when linked.

Survey of the other connectors (plan text of 0075 explicitly scoped recursion
out): root re-keying already walks the full ancestor chain for Codex, opencode,
and Antigravity; pi and Grok hop **one** level (a grandchild becomes its own
top-level session); Copilot keeps everything in one file with flat per-agent
streams; Junie has no linkage by design. No connector supplied an exact id or
a parent for a grandchild: Codex looked only in the root rollout's spawn map,
Copilot discarded the id it already had (`sub.agentId` IS the spawning
`task` call id), opencode built descriptions from the root session only,
Antigravity has synthesized ids only. No pi/opencode/Copilot/Grok/Antigravity
data exists on this machine.

## Goal

A subagent spawned by a subagent nests under the call that spawned it, in the
web, in windowed reads, and in Markdown/CLI/MCP output — for Claude Code with
exact ids, and for the connectors where that is a small, code-certain change.

## Decisions

- **Flat list plus a parent pointer, not a tree.** `SubagentRun.parentAgentId`
  names the run whose thread holds the spawning call. The API shape stays
  backward compatible; the web's map by tool-use id already covers nested
  runs; depth is derived where needed. Chains are acyclic (the parser breaks a
  cycle by unlinking the closing run).
- **Spawn points come from every thread.** All runs are assembled first, then
  spawn points are collected from the main thread and each run's thread,
  tagged with their owner — a parent may be listed after its child.
- **Matching order.** The exact id anywhere (except a run's own thread). Else,
  when the source names its parent, description/prompt matching is restricted
  to that parent's spawns. Else the previous main-thread-only behaviour, so
  legacy metadata can never pull a nested run under a same-named call in some
  other run. An unknown or self-referential parent is ignored.
- **Windows carry descendants.** A run is included when its spawn turn is in
  the slice or its parent is included, iterated to a fixpoint.
- **Scope.** Shared machinery + Claude Code (reads `toolUseId` and
  `parentAgentId`; `spawnDepth` is left unread since depth follows from the
  parent chain) + Codex (merge the spawn maps of every parsed
  child; parent from `thread_spawn`) + Copilot (pass the id it has plus the
  owning stream) + opencode and Antigravity (parent id; descriptions from every
  session). **pi and Grok are a follow-up**: their one-hop root re-key changes
  session identity and cannot be verified locally.

## Approach

1. Shared contract: `SubagentRun.parentAgentId`, `SubagentSource.parentAgentId`;
   parser `collectSpawns` over all threads, owner-scoped matching,
   `breakParentCycles`; `subagentsInWindow` fixpoint. Unit tests.
2. Connectors: Claude Code metadata fields; Codex spawn-map merge + parent;
   Copilot `toolUseId`/`parentAgentId`; opencode/Antigravity parent +
   descriptions from all sessions. Integration tests per connector, the Claude
   Code fixture taken from the real depth-2 files.
3. Web: `SubagentBlock` passes the run map into its own `ThreadList`;
   mount-before-navigate, hash targets, and search auto-open resolve through
   the ancestor chain; jump menu indents by depth.
4. Export and agent surfaces: Markdown export and `shapeSessionMarkdown` order
   runs depth-first and label nested ones with their parent.
5. Docs: CLAUDE.md gotcha.

## Files affected

- `packages/shared/src/thread.ts`, `packages/server/src/data/session-loader.ts` — contract.
- `packages/server/src/data/{parser,window}.ts` — spawn collection, matching, windows.
- `packages/server/src/connectors/claude-code/claude-code.ts`, `codex/{codex,normalize}.ts`,
  `copilot/{copilot,normalize}.ts`, `opencode/{opencode,normalize}.ts`,
  `antigravity/{antigravity,normalize}.ts`.
- `packages/web/src/pages/session/{SessionPage,ThreadView}.tsx`, `search.ts`.
- `packages/shared/src/markdown.ts`, `packages/server/src/agent/shape.ts`.
- Tests: `parser.test.ts`, `window.test.ts`, a Claude Code nested fixture, and
  one nested case per connector above.

## Testing

- `npm test`, `npm run typecheck`.
- Parser: exact id into another run (child listed first); the same-description
  trap with a named parent; legacy (no parent) stays main-thread only; unknown
  / self parent ignored; a cycle is broken.
- Window: nested runs ride with their ancestor and drop with it.
- API: the depth-2 Claude Code run carries `toolUseId` + `parentAgentId`; a
  window around the depth-1 spawn turn includes both runs; export nests.
- Web: Playwright on a real session with a depth-2 run.

## Risks / open questions

- Copilot: whether inner-inner events are tagged with the inner or the outer
  `agentId` is unverified (plan 0032 had no real sample either).
- pi/Grok grandchildren still surface as their own top-level sessions until
  their re-key walks the chain (follow-up).
- Antigravity and opencode nesting rests on description matching scoped to
  the named parent; synthetic fixtures only.
