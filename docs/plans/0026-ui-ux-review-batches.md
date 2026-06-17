# 0026 — UI/UX review: hierarchy pass across all screens

- **Status:** in-progress <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-17
- **PR:** Batch 1 — [#32](https://github.com/vladar107/claudescope/pull/32) · Batch 2 — [#33](https://github.com/vladar107/claudescope/pull/33)

## Context

An external UI/UX review produced 11 annotated before/after mockups covering
every main screen. They share one thesis — **hierarchy through subtraction**:
one bold number per unit (cost), everything else demoted to muted meta, a summary
strip to anchor each page, and raw values (BM25 scores, full-color emoji) replaced
with quiet visual encodings (a relevance bar, monochrome glyphs). The consistency
is the point; applied piecemeal each tweak is worth far less.

Current state (verified against the code), screen by screen:

- **Shell nav** (`App.tsx`) uses literal emoji icons (📁🧠🔍📊); the theme toggle
  (🖥☀🌙) and session-header actions (🧩 ▷ ⟳) are emoji too.
- **Browse** (`BrowsePage.tsx`) has no portfolio summary; cards mix agent badges
  and numbers together.
- **Project sessions** (`SessionList.tsx`) right-side chips can get ragged at
  narrower widths; no project summary strip.
- **Session view** (`SessionPage.tsx`, `ThreadView.tsx`) renders the header as one
  flat chip row and tool calls as collapsible blocks with no shared token legend.
- **Files changed** (`ChangesetPanel.tsx`) is a single-column accordion: per-file
  +/− only, no session diffstat, no jump rail, no viewed state.
- **Search** (`SearchPage.tsx`) shows flat rows with a raw BM25 `score X.XX`.
- **Analytics** (`AnalyticsPage.tsx`) shows a headline token count that doesn't
  obviously reconcile (cache reads dominate), a redundant cost chip, and chart
  colors that don't match the token-chip vocabulary.
- **Memory** (`MemoryPage.tsx`) shows bare counts and *hides* agents without
  memory (they look broken at "0 facts").
- **Continue popover** (`ContinueMenu.tsx`) truncates the command and doesn't
  explain resume vs fork.
- **Export** (`ExportMenu`) presents redaction as an opaque checkbox next to two
  equal-weight actions.
- **Codex/pi titles** fall back to the raw first message, markup and all
  (`first_user` in `data/index.ts`).

Most are pure presentation. Three carry **correctness/trust** obligations beyond
the visuals (export redaction wording, the title-cleaning logic, viewed-state
persistence) and are called out below.

## Goal

Ship the proposals across three batches, establishing one consistent visual
hierarchy and an app-wide icon set.

## Decisions

- **Adopt one icon set across the whole app, not just the 4 nav items.** Swapping
  only the nav trades emoji-nav for glyph-nav-next-to-emoji-toggle. Use a single
  React icon library (lucide-react is the natural fit) for nav + theme toggle +
  header actions + chevrons. **This adds a runtime dep** — flagged deliberately
  (CLAUDE.md: discuss deps first), not a drive-by.
- **Reuse one summary-strip component** for both the Browse portfolio header and
  the Project detail header, so the pattern is identical at both altitudes.
- **Cost stays the single bold figure per unit**, everything else muted — but keep
  the "list-price estimate" caveat at least once (Analytics), since cost is a
  local estimate (see cost gotchas).
- **Clean the fallback title in the shared path, not a Codex special-case.** pi has
  the identical no-stored-title behavior, so fixing `first_user` covers both
  (and is deterministic, so titles stay stable across re-index).
- **Viewed-state for Files-changed is client-only (localStorage).** It is ephemeral
  review UI state; persisting it server-side would add an index/state surface for
  no benefit and the read-only-sources rule stays untouched.
- **Cap model chips at three, `+N` reveals the rest on hover.** Sessions/projects
  can surface 1–5+ models; a shared `ModelChips` component owns the cap so the
  session header, session rows, and any card stay consistent.
- **Keep the redaction wording honest.** The toggle says it masks *likely* tokens /
  keys, not *all* secrets — because path rewriting (`/Users/me/… → ~/…`) is exact,
  but secret detection is pattern-matching that can miss a key it doesn't recognize.
  The little before/after in the panel is an illustrative example of the
  transformation, not a coverage promise. Don't reword it to imply a guarantee.
- **Drop the "RECOMMENDED" label** on resume-in-place: resume (same history/id) vs
  fork (branch safely) is intent-dependent; labeling one nudges with no
  universally-right answer. Keep both neutral. (Per the user's explicit request.)

## Approach

### Batch 1 — visual hierarchy + low-risk clarity/correctness fixes

1. **① Monochrome icon set** (`App.tsx`, theme toggle, session header, chevrons) —
   replace all emoji glyphs with one lucide-react set. Add the dep.
2. **Shared `ModelChips`** — a capped chip row (max three + a `+N` overflow that
   lists the rest on hover); one component, reused by the session header and the
   session rows. Sessions/projects can surface 1–5+ models, so the cap is the rule
   everywhere models appear.
3. **③ Project summary strip + one-line session meta** (`SessionList.tsx`,
   `ProjectLayout.tsx`) — SESSIONS / TOKENS / COST / AGENTS strip up top; collapse
   the right-side chips into one tidy meta line (`opus-4-8 · haiku-4-5 │ 24M
   $20.22`) using `ModelChips`; PR link on its own line.
4. **⑥ Browse portfolio summary + badge/number split** (`BrowsePage.tsx`,
   `ProjectCard`) — PROJECTS / SESSIONS / SPEND / AGENTS strip; separate agent
   badges (own row) from numbers (muted meta line); cost the one bold figure.
5. **② Session header restructure** (`SessionPage.tsx`, session header) — two
   tiers: **tier one** promotes title + subagents chip, agent badge, `ModelChips`,
   cost, tokens, duration, with PR as a real action button and Continue / Subagents
   / Export / Refresh in the top bar; **tier two** is a muted meta line (messages,
   tools, branch, timestamps, size — present, not loud).
6. **⑦ Analytics reconcile / dedupe / recolor** (`AnalyticsPage.tsx`) — headline
   token count decomposed as in + out + cache with a mini stacked bar; remove the
   redundant cost chip, replace with context ("list-price estimate · N% cache-read");
   recolor charts to the token-chip blue (input) / violet (output).
7. **⑨ Continue popover redesign** (`ContinueMenu.tsx`) — full untruncated command
   (wraps), resume vs fork explained in a line each, context chips (agent / project
   / branch), the trust line "Claudescope only copies a command — it never runs
   anything", **no RECOMMENDED label**.
8. **⑪ Fallback title cleaning** (`data/index.ts`, `first_user`) — strip markup /
   wrapper tags / leading `#`, pick the first real user prose (skip
   system/tool-injected blobs), collapse whitespace, truncate; surface an "untitled
   · from first message" marker in the session header. Covers Codex and pi.

### Batch 2 — grouping, previews, privacy

9. **⑤ Search grouping + relevance bar** (`SearchPage.tsx`) — collapse N matches
   into one session card ("7 matches"), "N matches across M sessions" framing,
   replace raw BM25 with a relevance bar normalized per result-set (max → full).
10. **⑧ Memory previews + "no memory store"** (`MemoryPage.tsx`,
    `MemorySourceCard`) — each card previews real content (latest fact + category;
    the parser already extracts facts); show agents *without* memory explicitly as
    "no memory store" with a one-line explanation instead of hiding them.
11. **⑩ Export redaction transparency** (`ExportMenu`) — explain what the toggle
    does with an illustrative before/after example; Download primary, Copy
    secondary; keep the "likely / best-effort" wording.
12. **② Session thread polish** (`ThreadView.tsx`) — add the shared token legend up
    top; demote tool calls / `call_…` ids to one quiet "details" line by default,
    **ensuring expand still yields the existing rich rendering** (inline diffs,
    highlighted code).

### Batch 3 — biggest build (scope carefully)

13. **④ Files-changed jump rail + diffstat + viewed** (`ChangesetPanel.tsx`,
    `LineDiff`) — two-pane layout (file rail left, diff right), session-level
    diffstat (`+412 −86`) up top, per-file +/− in the rail, and a "viewed" checkbox
    per file (localStorage) with an "N of M viewed" progress indicator.

## Files affected

- `packages/web/src/App.tsx` — icon set, theme toggle glyphs.
- `packages/web/src/pages/browse/BrowsePage.tsx` (+ `ProjectCard`) — portfolio
  summary, badge/number split.
- `packages/web/src/pages/browse/SessionList.tsx`, `ProjectLayout.tsx` — project
  summary strip, one-line session meta.
- `packages/web/src/pages/analytics/AnalyticsPage.tsx` — reconcile, dedupe, recolor.
- `packages/web/src/pages/session/ContinueMenu.tsx` — popover redesign.
- `packages/web/src/pages/session/ExportMenu*` — redaction UX, button hierarchy.
- `packages/web/src/pages/session/SessionPage.tsx` (+ session header) — two-tier
  header, cost/models promoted, counts/branch/size demoted.
- `packages/web/src/pages/session/ThreadView.tsx` — token legend, tool-line demotion.
- `packages/web/src/components/ModelChips.tsx` *(new)* — shared capped model-chip
  row (max three + `+N` hover), reused by the header and session rows.
- `packages/web/src/pages/search/SearchPage.tsx` — grouped results, relevance bar.
- `packages/web/src/pages/memory/MemoryPage.tsx` (+ `MemorySourceCard`) — previews,
  "no memory store".
- `packages/web/src/pages/session/ChangesetPanel.tsx` (+ `LineDiff`) — jump rail,
  diffstat, viewed state.
- `packages/server/src/data/index.ts` (`first_user`) — shared title cleaning.
- shared CSS (`session.css`, etc.) and possibly `packages/shared/src/api.ts` if the
  relevance bar / grouped search shape needs a contract tweak.
- `package.json` — add `lucide-react` (or chosen icon lib).

## Testing

`npm test` + `npm run typecheck` after each batch.

- **Title cleaning** (server, deterministic) — markup/wrapper stripping, system-blob
  skip, truncation, stability across re-index; covers a Codex *and* a pi fixture.
- **Export redaction** — the live example reflects the real redactor; path rewrite
  vs heuristic secret match behave as documented (no over-claim on misses).
- **Search relevance normalization** — bar maps sensibly when BM25 scores are
  large/unbounded; grouping collapses duplicate session rows correctly.
- **Viewed state** — persists across reload, scoped per session, never written to
  any agent source.
- Mostly visual otherwise — manual check against the mockups per screen.

## Risks / open questions

- **New dependency.** `lucide-react` — confirmed by the maintainer.
- **Redaction is best-effort for secrets.** Path rewriting is exact, but secret
  masking is pattern-based and can miss an unrecognized key. The UI must not imply a
  guarantee — the "likely" wording is load-bearing, not cosmetic. (A user who trusts
  a "redacted" export and leaks a token is the failure mode to avoid.)
- **ThreadView demotion must preserve rich expand.** Inline diffs / highlighted code
  are a selling point; the one-line default must expand to the existing rendering,
  not a degraded view.
- **Session-row wrap discrepancy.** Current `SessionRow` chips are `flex` no-wrap in
  code; the mockup reports ragged wrapping. Confirm at real widths — the one-line
  meta is the right target regardless.
