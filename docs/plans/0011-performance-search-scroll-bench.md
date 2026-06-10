# 0011 — Performance: in-session search, huge-session scrolling, perf-suite redesign

- **Status:** in-progress
- **Date:** 2026-06-10
- **PR:** <links per workstream, once opened>

## Context

Three confirmed performance problems:

1. **In-session search is laggy on a ~28MB session.** The finder is fully
   client-side; every debounced keystroke re-walked the entire thread +
   subagents, calling `blockText()` which `JSON.stringify`s every tool input
   and `.toLowerCase()`s every block (`packages/web/src/pages/session/search.ts`).
   On 28MB that is ~56MB+ of fresh string allocation per query. Highlighting is
   already cheap (CSS Custom Highlight API, scoped to the active block).
2. **Scrolling a ~150MB session is janky; items appear with delay.**
   `GET /api/sessions/:id` returns the whole parsed session in one JSON
   response; `ThreadList` mounts every turn in one React commit with no
   virtualization — the only mitigation is CSS `content-visibility: auto;
   contain-intrinsic-size: auto 140px`, whose 140px estimate badly
   underestimates real turn heights. Expanded tool results render fully into
   the DOM with no truncation. (Collapsed `Collapsible` bodies are *not*
   mounted, so the cost is the initial commit + per-turn lazy layout +
   unbounded expansion.)
3. **The perf suite measures noise — confirmed from CI logs (8 runs, June
   2026).** `search.p95_ms` swung −28.5%…+35.4% on PRs not touching search;
   `noop_reindex.wall_ms` ranged 1.65–4.5ms (+111% swings) — *below the
   suite's own 25ms floor*. Dead-gate bug: in `packages/server/perf/compare.ts`,
   `ms`-unit metrics under the floor can only ever produce alarming "noise"
   verdicts, never gate; the only metric that can actually fail CI is
   `cold_index.events_per_sec`, whose A/A spread (~16%) sits just under the
   20% threshold. Root causes: 5 samples / 1 warmup, raw samples discarded,
   sequential A-then-B blocks on a drifting shared runner, fixtures too small
   (timings 2–20ms ≈ VM jitter).

## Goal

Search inside a large session responds in milliseconds after the first query;
a 150MB session scrolls without long main-thread tasks; the perf gate fails
only on statistically significant regressions and stops emitting false "noise"
verdicts. No new dependencies.

## Decisions

- **Search: precompute a lowercased corpus once per session, scan strings per
  query** — rejected a Web Worker (no infra; structured-clone cost; scans over
  a prebuilt corpus are fast enough) and incremental query refinement
  (complexity without measurable benefit; backspace/filter changes would
  invalidate it).
- **Scrolling: clamp + progressive mount, not windowed virtualization** —
  react-virtuoso/@tanstack/react-virtual rejected for now: new dependency,
  variable/huge item heights, and the finder/anchor flows need target turns
  mounted. `content-visibility: auto` already skips off-screen layout; the
  remaining costs are the single giant React commit (fixed by chunked
  mounting) and unbounded expanded tool output (fixed by clamping).
  Server-side truncation/pagination rejected: breaks finder/changeset
  contracts; revisit only if load time (not scroll) remains the pain.
- **Perf suite: keep a failing gate, make it statistical** — full advisory
  mode rejected (plan 0003's purpose is a gate). Interleaved A/B rounds cancel
  temporal runner drift (the dominant noise); batched samples push every gated
  number above jitter; Mann-Whitney U + threshold + floor make FAIL mean
  something.

## Approach

### A — In-session search (smallest, first)

1. `search.ts`: split `buildMatches` into `buildSearchCorpus(thread, subagents,
   subagentsByToolUseId): CorpusEntry[]` (render-order walk, one entry per
   non-empty block: `{blockId, turnUuid, subagentId?, role, text}` with `text`
   pre-lowercased; no role filtering) and `findMatches(corpus, query, filter)`
   (trim+lowercase query once, `indexOf` loop per entry). `buildMatches`
   remains as the one-shot composition; `occurrenceInBlock` semantics and
   `finderDom.ts` unchanged.
2. `SessionPage.tsx`: corpus memo built lazily only while a non-empty debounced
   query exists (non-searching readers pay nothing; memory drops when the query
   clears); matches memo scans the corpus per query/filter change.
3. Tests: corpus order/lowercasing/skip-empty; `findMatches(corpus, …)` ≡
   `buildMatches(…)`; role filter at scan time; JSON tool input searchable.

### C — Perf suite (second)

1. `types.ts`: `Metric` gains `samples: number[]` + `itersPerSample`;
   `BenchResult.meta` gains `schemaVersion: 2`, `round?`.
2. New `perf/stats.ts` (pure, no server imports): `median`, `percentile`,
   `iqr`, `cv`, `mannWhitneyUOneSided` (normal approximation, tie-corrected).
3. `scenarios.ts`: `batched(fn, iters)` helper so each sample times N
   iterations — `noop_reindex` ×50, `search` ×25, `analytics` ×10,
   `single_file_reindex` ×10, `session_load` ×3; warmup 2 for batched
   scenarios. Headline set becomes `cold_index.events_per_sec`,
   `noop_reindex.batch_ms`, `search.batch_ms`; `search.p95_ms` demoted to
   informational.
4. `run.ts`: accept `--round <n>` (meta only); CI runs `--scale 2`.
5. `compare.ts`: accept multiple base/candidate files, pool samples per metric.
   Gate: FAIL only if pooled candidate median regresses > threshold (10%) AND
   Mann-Whitney one-sided p < 0.01 AND above floor. Base CV > 12% →
   "inconclusive" (visible, doesn't fail). v1-schema base files → advisory,
   exit 0 (bootstrap). Summary shows median ±IQR, Δ%, p, CV, verdict.
6. `perf.yml`: 5 interleaved rounds alternating side order (odd rounds
   base-first), each writing `base-$i.json`/`cand-$i.json`; compare with
   `--threshold 10`. Job ~6–7 min (vs ~3–4).

### B — Scrolling (largest, last)

1. New `components/ClampedText.tsx` (`{text, limit≈50k chars, forceExpand?}`):
   under limit renders `<pre><code>` as today; over limit renders the head cut
   at a line boundary + "Show all (N MB, ~M lines)"; `forceExpand` (finder
   reveal) overrides. Applied at every unbounded-text sink: `ToolBlock.tsx`
   plain-`<pre>` fallback / Bash output / stringified input, `Markdown.tsx`
   `markdown={false}` path, `ThreadView.tsx` `SystemTurn`. Plus a size gate in
   `Markdown.tsx`: >~100k chars never hits remark (ClampedText + "Render as
   markdown anyway").
2. New `pages/session/useProgressiveMount.ts`: mount first ~80 turns, grow ~50
   per `requestIdleCallback` until done; `ensureMounted(uuid)` for deep links
   and finder navigation; monotonic across soft refresh. `ThreadList` renders
   `visibleItems` (top level only).
3. Re-commit hygiene: `React.memo` on `Turn`; fix the hooks-rule violation
   (`useContext` after conditional return); `contain-intrinsic-size: auto 280px`.

## Files affected

- `packages/web/src/pages/session/search.ts`, `SessionPage.tsx`,
  `packages/web/test/search.test.ts` — workstream A.
- `packages/server/perf/{types,stats,scenarios,run,compare}.ts`,
  `.github/workflows/perf.yml` — workstream C.
- `packages/web/src/components/{ClampedText.tsx,limits.ts,ToolBlock.tsx,Markdown.tsx}`,
  `packages/web/src/pages/session/{useProgressiveMount.ts,ThreadView.tsx,SessionPage.tsx,blocks.tsx,session.css}`
  — workstream B.

## Testing

- `npm run typecheck` + `npm test` per workstream.
- A: DevTools Performance — first query shows one corpus-build task; subsequent
  edits/filter toggles are millisecond-scale; finder behavior identical.
- C: A/A validation (workflow on a no-op diff: all `ok`, p ≥ 0.01); injected
  ~30% slowdown on a scratch branch must FAIL with p < 0.01; bootstrap PR
  renders advisory and exits 0.
- B: before/after Chrome traces on the same large session — no >200ms task
  during fast scroll; expanding a multi-MB tool block <100ms; deep links,
  finder navigation (incl. clamped tails), changes tab unchanged.

## Risks / open questions

- Corpus duplicates session text lowercased (~1× transcript size) while a
  search is active — acceptable; freed when the query clears.
- Clamping changes UX for huge outputs (head + "Show all"); finder must
  force-expand clamps when a match lands in the hidden tail.
- Interleaved rounds raise perf CI to ~6–7 min; acceptable for a PR-only job
  with cancel-in-progress.
- If scroll jank persists after B, the documented fallback is windowed
  virtualization (new dependency, needs explicit approval).
