# 0095 — Live tab: active sessions, subagents, and agent-to-agent messages

- **Status:** done
- **Date:** 2026-11-02
- **PR:** https://github.com/vladar107/claudescope/pull/130 (stage 1), https://github.com/vladar107/claudescope/pull/131 (stage 2), https://github.com/vladar107/claudescope/pull/132 (stage 3), https://github.com/vladar107/claudescope/pull/133 (stage 4)

## Context

Claudescope looks backwards: browse, search, and analyze finished transcripts.
People who run several agents at once (two Claude Code sessions, a Codex run,
subagents fanning out) have no single place to answer *which one needs me,
which one is stuck, and what are the subagents saying to each other*. Every
agent's own UI shows only itself.

Most of the plumbing exists:

- The reindex poller refreshes the index every 15 s (`reindexIntervalMs`), and
  the web app refetches on `dataVersion` (`useDataVersionRefetch`).
- `GET /api/sessions/:id/fingerprint` live-stats a session's files without a
  reindex. The session page polls it every 2 s while the file was written in the
  last 3 min (`useLiveSession`).
- `loadSessionData` + `assembleThread` + `buildSubagentRuns` parse a session
  straight from disk. They already pair `tool_use` with its result
  (`ToolInteraction.result` absent = still open) and nest subagent runs,
  including grandchildren (`parentAgentId`).
- `sessions` already carries cost, `context_tokens`, and `compaction_count`, and
  `agent-capabilities.ts` already says which agents can't record them.

Hard limits that shape the design:

- **No process introspection.** Only Copilot writes an end marker
  (`session.shutdown`), so "running" can't be known. Every state is *inferred
  from the transcript tail*, and the UI says so.
- **Uneven signals per agent.** Copilot's tokens land only at shutdown,
  Antigravity records none, Grok records usage per user turn, and Junie has no
  assistant prose and no subagent linkage. Mid-run messages between agents are
  recorded only by some formats (see C6).

Design canvas (5 boards, MVP to target, plus a state/capability sheet):
<https://claude.ai/artifact/L7QGgH6EGiq2D9wNQjhVjx>

## Goal

A **Live** tab that lists sessions written to within a window (5 min / 15 min /
1 h). For each one it shows the inferred state, what the session is doing,
its subagents, and its cost/context so far. A focus view per session draws the
agent tree and the messages between agents. The feature ships in four PRs, each
usable on its own.

## Decisions

- **Its own tab, not a strip on Browse.** This is a different job ("now") from
  Browse ("history"), and it needs room for subagents. The nav badge shows the
  active count, so it can be found from anywhere.
- **One derivation, from the assembled thread, never from SQL rows.** State
  comes from the tail of `assembleThread` output, where tool results and
  subagent runs are already paired and nested. Rejected: inferring state from
  `events` rows. Claude Code splits one message across rows and `events` has no
  tool-use ids, so a second, SQL-shaped rule set would drift from the parser.
  The index is used only to *select candidates* and for stored metrics (cost,
  context, compactions).
- **Recency = file mtime, for sessions.** Candidates are files whose
  `files.mtime_ms` is at least `now − window − reindexInterval`. A live
  fingerprint stat, batched into one `files` query for all candidates, then
  confirms each one. mtime works the same for every agent (Grok can fall back
  to summary-time *event* timestamps), and the stat already goes through each
  connector's `statFile`.
  - **Exception: subagent runs** use the `timestamp` of their own thread's
    last item. Copilot runs live inline in the parent file, and `SubagentRun`
    carries no path.
- **Fingerprint-keyed cache of derived results only.** Assembled threads are
  never kept. An unchanged session costs only a `stat`. A changed one is
  re-derived at most once per second (stage 2). Candidates are capped at 20.
  The live path loads with images left unresolved: Copilot and Antigravity
  otherwise base64-read every screenshot on each re-derive. This needs a load
  option on `loadSession`.
- **Time-dependent values are computed on the client.** The server returns
  `lastWriteMs`, `openSinceMs`, and the base state. The client works out ages,
  open duration, and the "possibly stuck" overlay (threshold is a UI control).
  The stage 2 ETag is a hash of the response body, so it changes exactly
  when a visible value does. That includes time-driven subagent liveness, and
  a value that changes with time alone is never frozen.
- **Honest absence, declared per connector.** New capability maps go in
  `data/agent-capabilities.ts`, each with a conformance test that walks the
  registry (the `TOOL_ERROR_SIGNAL` pattern):
  - `LIVE_STATE_SIGNAL`: whether the generic tail rules apply. Junie's
    UI-event stream has no assistant prose, so its tail reads as `unknown`
    rather than a fabricated `tool`/`working`.
  - `SESSION_END_SIGNAL`: only Copilot today.
  - `AGENT_MESSAGE_SIGNAL`: `mid-run` | `spawn-result` | `none`.

  Absent cost/context render as "not recorded" or "at session end", never 0.
- **An end marker travels on `SessionData.endedAt`, not as an index row.**
  Copilot's `loadSession` sets it from `session.shutdown`. A later
  conversational event clears it (a resumed session). Rejected: a canonical
  `session_end` row, which would reach the index and change its counts.
- **The live routes never wait on the indexer.** One DuckDB connection serves
  the indexer and every route, and a long pass blocks the queue. On a real
  machine that meant 4–10 s responses during passes. Candidate `files` rows
  and session metrics come from an in-memory snapshot. It is refreshed in the
  background when `dataVersion` changes, and the current snapshot is served
  meanwhile. Transcripts are loaded through the connector with those paths,
  so no per-session query runs.
- **States are read from the last block of the last main-thread item**
  (board "Card states"). The parser drops rows that carry only tool results, so
  "the last item is a tool result" never occurs:
  - text → `idle`. A finished agent is idle; "your turn" claimed more than
    the transcript shows.
  - Claude Code interrupt marker or a local-command row → `idle`. This
    reuses `hasInterruptSignal` and moves `INTERRUPT_PREFIX` out of
    `routes/analytics-errors.ts` into a shared spot instead of adding a third
    copy.
  - closed tool, thinking-only, or a user prompt → `working`
  - open tool → `tool`, labelled with its name
  - any active subagent run → `subagents`. A run is active when it was
    written within the window and either has an open call, or reads
    `working` and wrote within the last 90 s. Some harnesses end a run with
    a closed hand-back call instead of final text. The spawning call's result
    is not the signal: Codex `spawn_agent` and Claude Code background agents
    return immediately.
  - declared end marker → `ended`
  - otherwise, or when `LIVE_STATE_SIGNAL` says no → `unknown`

  The client adds "possibly stuck" on top of `tool`/`working`/`subagents`
  when there have been no writes past its threshold. The label claims nothing
  about approvals.
- **Agent-to-agent messages are a derived ledger, not a new index table.**
  `AgentMessage { at, from, to, kind: spawn|message|result|notification|wait,
  text (capped), anchorUuid }`. It is built from spawning calls, their results,
  and agent-message tool calls. Format-specific tool names (Claude Code
  `SendMessage`, Codex `send_input`/`wait_agent`) reach `data/` through a
  connector hook, never as literals (`architecture-rules.test.ts`).
- **Read-only, always.** No controls (stop, approve, send) and no writes to any
  agent source. Notifications (stage 4) are browser-local and opt-in.
- **Polling, not SSE.** The app already polls everywhere, and a 2–3 s poll that
  returns 304 is cheap. SSE would add a second transport to keep correct.

## Approach

Each stage is one PR. Stop after each for the user to try it.

### Stage 1 — MVP: Live tab at index cadence (board 1)

| Chunk | Task | Tier (Jev) | Depends |
| --- | --- | --- | --- |
| C1 | Shared contract in `packages/shared/src/api.ts`: `LiveState`, `LiveSession` (`SessionMeta` subset + `state`, `lastWriteMs`, `openTool?: { name, input (capped), sinceMs }`, `subagents: { running, done }`), `LiveResponse`, plus the signature of `deriveLiveState`. | Orchestrator | — |
| C2a | `data/live-state.ts`: a pure `deriveLiveState(thread, runs, { connectorId })` following the Decisions rules. Add `LIVE_STATE_SIGNAL` and `SESSION_END_SIGNAL` with their conformance tests, move `INTERRUPT_PREFIX` to a shared spot, and have Copilot's `loadSession` return `SessionData.endedAt`. Unit tests per the acceptance list. | Complex (Jev complex 1.00, as part of C2) | C1 |
| C2b | `routes/live.ts`: `GET /api/live?windowMin=` selects candidates from `files.mtime_ms`, confirms them with one batched fingerprint stat, loads each session through the image-free load option, and derives through the fingerprint-keyed result cache. It joins stored metrics from `sessions` with capability absence. `GET /api/live/count` is a stat-only endpoint for the nav badge that counts sessions written within the window, with no parsing. Copy the route shape from `routes/sessions.ts`. Integration tests. | Complex (Jev complex 1.00, as part of C2) | C2a |
| C3 | Web: `pages/live/LivePage.tsx` + `live.css` (table per board 1), route `/live`, nav item whose badge polls `/api/live/count`, `api.live()`, refetch via `useDataVersionRefetch`, client-side ages and the "possibly stuck" overlay, window select remembered in `localStorage` (try/catch). Copy `BrowsePage` patterns. | Simple (Jev simple 0.83) | C1 |

Waves: **W1** C1 → **W2** C2a ∥ C3 → **W3** C2b → review → PR.

Acceptance:

- `deriveLiveState` unit tests cover the weird edges:
  - an open tool as the last block
  - a closed tool as the last block, giving `working`
  - a Claude Code `[Request interrupted by user]` row, giving `idle`
  - a message split across rows with the `tool_use` row last
  - a Codex `spawn_agent` whose `Task` closed immediately while the child's
    tail is still open, giving `subagents`
  - Copilot `endedAt` giving `ended`, then a later event clearing it
  - a Junie tail giving `unknown`
- Integration tests over synthetic fixtures check that:
  - a file outside the window is excluded
  - absent cost/context come back absent, not 0
  - the cap holds
  - `/api/live/count` loads no session
- The page lists the fixture sessions with the right state pills.
- `npm test` and `npm run typecheck` pass.

### Stage 2 — Fast tail, cards, subagents inline (board 2)

| Chunk | Task | Tier (Jev) | Depends |
| --- | --- | --- | --- |
| C4 | `/api/live` detail: the last assistant snippet, per-run subagent state and open tool, tool/error counts. Add a weak ETag over the response body → `304`, a stat-only "finished in the last hour" list, and a per-session re-derive floor of 1 s. The web formats the one-line tool summary by exporting `toolDescriptor` from `ToolBlock.tsx`; the server sends only the capped input. | Complex (Jev complex 0.94) | Stage 1 |
| C5 | Web: cards grouped by Idle / Working, a 2.5 s poll while the tab is visible and something is working, 30 s otherwise, a "Finished in the last hour" table, and a ticking "last write" age. | Complex (Jev 0.67 → decided complex: poll lifecycle + grouping edge cases) | C4 contract |

Waves: orchestrator extends the C1 types → **W1** C4 ∥ C5 → review → PR.

Acceptance:

- Tests: an unchanged response returns `304`, an append returns `200` with a
  new ETag, and two requests within the floor re-derive once.
- In the browser, polling pauses while the tab is hidden and drops to 30 s
  when nothing is working. A running fixture flips from `tool` to `idle`
  within one poll after an append.

### Stage 3 — Session focus: agent tree and messages (board 3)

| Chunk | Task | Tier (Jev) | Depends |
| --- | --- | --- | --- |
| C6 | Read-only research on the user's real transcripts and the connectors: how each agent records spawn prompts, mid-run messages (Claude Code `SendMessage`, `<task-notification>` rows, background agents; Codex `send_input`/`wait_agent`/`close_agent`), and results. Also check whether Codex `task_complete`/`turn_aborted` (dropped by the normalizer today) would give a firmer idle/interrupt signal than the tail rules. Output: a shapes summary plus synthetic fixture lines. Nothing is copied verbatim from real transcripts. | Lookup (Jev 0.26 → decided: read-only lookup, cheapest tier per tiering rules) | — |
| C7 | `data/agent-messages.ts`: build the `AgentMessage[]` ledger from the thread + `SubagentRun`s (nested runs included). Add an `interAgentSignals?` connector hook for format-specific tool names and user-row patterns (Claude Code `SendMessage`, `TaskOutput`, `TaskStop`, `<task-notification>`, `<agent-message from>`; Codex `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`), `AGENT_MESSAGE_SIGNAL` + its conformance test, and `GET /api/live/:sessionId` (tree + ledger + per-run live state; works for any session). | Complex (Jev complex 0.97) | C6 |
| C8 | Web: `/live/:sessionId` focus page with the agent tree, a swimlane timeline (one lane per agent), and message detail. "Jump to transcript" goes to `/sessions/:id` and lands on `anchorUuid` with the instant jump + `holdAnchor` (never smooth scroll). Link to it from each Live card. | Complex (Jev 0.48 → decided complex: layout of nested runs + anchor landing) | C7 contract |

Waves: **W1** C6 → orchestrator adds the `AgentMessage` types → **W2** C7 ∥ C8
→ review → PR.

Acceptance:

- Fixture tests per connector with subagents check that spawn and result edges
  exist, and that a grandchild's spawn is attributed to its parent run, not to
  main.
- Claude Code and Codex fixtures produce `message` edges.
- An agent declared `none` yields no edges and a "not recorded" note.
- The jump lands on the message's turn in the transcript.

### Stage 4 — Target: lanes, trends, notifications (board 4)

| Chunk | Task | Tier (Jev) | Depends |
| --- | --- | --- | --- |
| C9 | Server: per-session events per minute for the last 30 min, burn rate ($ over the last 10 min, canonical usage only), and today totals (spend, tokens, sessions) in the viewer's timezone. Reuse `analytics-scope.ts` timezone helpers and `analytics-metrics.ts` counting rules. Compaction positions for the context-bar ticks come from `compactions.pre_tokens`. | Complex (Jev 0.44 → decided complex: timezone + counting rules are bug-prone) | Stage 3 |
| C10 | Web: lanes (Idle / Working / Possibly stuck), a KPI strip with snapshot and "today" groups split by the │ separator, inline SVG sparklines, compaction ticks. Optional, last, and droppable: an opt-in browser notification + title badge when a session turns `idle`, and `j`/`k`/`Enter`. | Complex (Jev complex 0.89) | C9 contract |
| C11 | Docs: a README "Live" section and a minimal CLAUDE.md gotcha (states are inferred, capabilities declared, the derivation is from the thread). Set plan status. | Orchestrator | C9, C10 |

Waves: **W1** C9 ∥ C10 → **W2** C11 → final review → PR.

Acceptance:

- Integration tests:
  - activity counts items across main and runs, and a cached result is
    trimmed to the request's clock without re-deriving
  - cost minutes count only canonical usage and line up with the usage minute
  - cost is absent for agents without per-response usage
- "Today" reuses `/api/analytics?groupBy=day` with the browser timezone, so
  it inherits that route's timezone tests.
- In the browser, notifications are requested only on opt-in. They never fire
  on the first load, and the opt-in is dropped if permission is revoked.

As built, three things differ from the chunk rows above:

- Compactions are read from the assembled thread (`ThreadItem.compaction`),
  not the `compactions` table, so the live path issues no query for them.
- "Today" uses the existing analytics endpoint rather than a new server
  figure.
- "Sessions today" is dropped, because that endpoint has no per-day session
  count.

**Worker tiers.** The session runs on Opus. Complex chunks go to Sonnet,
simple chunks to Haiku, and C6 (read-only) to Haiku `Explore`. At most three
agents run in parallel.

**Wave reviews (explicit exception).** A fresh Opus `general-purpose` agent
reviews each wave, as the plan workflow requires. It is a reviewer, not a
worker: it writes no code and doesn't inherit the implementation context.

## Files affected

- `packages/shared/src/api.ts`: live types, `AgentMessage`.
- `packages/server/src/data/live-state.ts`, `data/agent-messages.ts` (new).
- `packages/server/src/data/agent-capabilities.ts`: `SESSION_END_SIGNAL`,
  `AGENT_MESSAGE_SIGNAL`.
- `packages/server/src/connectors/types.ts` + Claude Code and Codex
  connectors: `interAgentSignals?` hook (stage 3).
- `packages/server/src/routes/live.ts` (new), `routes/index.ts`: registration.
- `packages/web/src/pages/live/*` (new), `App.tsx`: route and nav,
  `api/client.ts`.
- `packages/server/test/*`: unit, integration, and conformance tests.
- `README.md`, `CLAUDE.md` (stage 4 only).

## Testing

`npm test` and `npm run typecheck` after each wave. The integration suite builds
the index from synthetic fixtures in a temp dir; no real agent source is touched.
Each stage is checked end to end with `/verify` (sandboxed fixtures, with one
fixture appended mid-run to watch the state flip). UI stages are compared to the
canvas boards with Playwright screenshots before presenting.

## Risks / open questions

- **Parse cost of big live sessions.** Re-assembling a 50 MB transcript every
  2 s per live session is heavy. Mitigations:
  - the 1 s floor and the cap of 20
  - the image-free load
  - one batched `files` query per poll, so the shared, serialized connection
    doesn't queue 20 per-session queries behind indexer passes
  - polling only while visible

  If it still shows up, a later step tails only the appended bytes for Claude
  Code (the other connectors re-normalize whole files by design).
- **New sessions appear only after a reindex** (≤ 15 s), because candidates
  come from the `files` table. Acceptable for now.
- **"Possibly stuck" is a heuristic.** A long `npm install` looks the same as
  a pending approval. The copy stays tentative, and the threshold (default
  3 min) is a client-side UI control, not a setting.
- **Subagent liveness relies on the run's own timestamps.** A run whose format
  writes no per-event timestamps (Grok with a missing `updates.jsonl`) falls
  back to the session file's mtime.
- **Codex and Copilot interrupts read as `working`** (then "possibly
  stuck"). Codex's `turn_aborted` and Copilot's `abort` are dropped by their
  normalizers, and the agents aren't in `INTERRUPT_SIGNAL`. Adding them changes
  interrupt analytics too. C6 confirmed the signals exist (`task_complete`, `turn_aborted`); wiring them in is left for a separate change.
- **opencode in-flight tools** used to get a `tool_result` regardless of
  status. They now stay open until `completed`/`error`. An in-flight
  `apply_patch` stays a raw call, so Files changed reports only confirmed
  edits.
- **Mid-run message formats are unverified** until C6. If Codex doesn't
  persist `send_input`, it is declared `spawn-result` and the board copy
  changes.
- **Nav order.** The boards put Live first, above Browse. Alternative: right
  after Browse, which stays the index route.
- **Out of scope:** CLI/MCP `live` subcommands, controlling agents, and
  pi/Grok grandchildren (they still re-key one hop only).
