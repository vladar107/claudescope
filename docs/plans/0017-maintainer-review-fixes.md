# 0017 — Maintainer review fixes: resiliency tests, daemon hardening, render & contract guards

- **Status:** proposed <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-06-15
- **PR:** <link, once opened>

## Context

A maintainer-style code review raised five themes: harden daemon/process
lifecycle, make parser/indexer invariants explicit, reduce scattered runtime
special-cases, add boundary validation, and keep tests focused on the hard cases.

We assessed each theme against the actual code with a fan-out of mappers, then
adversarially re-verified every candidate finding against the source (a finding
only survived if a second agent could confirm it by re-reading the cited code).
Result: **37 candidate issues → 19 real (almost all low severity) → 16 false
positives → 3 the area-split missed.** There is **no high-severity bug**. The
reviewer's thesis is right (quality is good; risk concentrates in the
parser/indexer and daemon), but most of the review's *specific* asks resolve to
low-value polish. The genuinely worthwhile work is a small set:

- Two **untested resiliency paths** the code already implements (index-corruption
  self-heal; daemon stale/wedged recovery).
- One **real lifecycle bug** (a wedged-but-alive daemon is orphaned, not replaced).
- Two **structural seams the review didn't name**: no React error boundary, and an
  unenforced DuckDB-column → shared-type mapping.
- The **pricing.json config has no migration** (unlike the self-healing index) —
  same silent-drift class of risk, flagged by the user as important.

Scope agreed with the maintainer: **Tier 1 + Tier 2 + the pricing migration**;
Tier 3 cleanups only where they fall inside files already being touched.

This is a localhost, single-user, read-only app — severity and "done" are judged
against that threat model (no auth/rate-limiting concerns).

## Goal

Lock the two self-healing recovery paths with tests, fix the one real daemon gap,
stop a single render throw or a column rename from silently degrading the app, and
give the user-editable `pricing.json` the same non-destructive, versioned
self-reconciliation the index already enjoys — all as minimal, in-style changes.

## Decisions

- **Test the recovery paths without source changes** — assert
  `discardCorruptDb`/stale-schema rebuild via the existing `console.warn` signal +
  post-rebuild data equality, rather than adding test seams to `db/duckdb.ts`.
  Honors "no drive-by refactors / add tests only where logic warrants."
- **Fix the wedged-daemon case by replacing, not orphaning** — on
  *alive-but-unhealthy*, `SIGTERM` + wait-for-exit then respawn; if it won't die in
  budget, **stop with an actionable error** (no auto `SIGKILL` — avoid nuking a
  possibly-recycled PID). Rejected: blindly spawning (today's behavior → EADDRINUSE
  + 20s timeout + orphan).
- **Hand-written class `ErrorBoundary`, no new dependency** — React 19 error
  boundaries must be class components; `react-error-boundary` is not a dep and
  CLAUDE.md gates new deps. Reuse `ErrorBox` for the fallback so there's zero new
  CSS. Two tiers: root (keeps the sidebar alive) + per-block (one bad transcript
  block degrades locally).
- **Guard the column→DTO seam with a typed row-reader that throws on drift** —
  a missing column becomes a loud 500, not a silent `0`/`''`. Reinforce with a
  fixture "DTO completeness" assertion. Rejected: a shared column-name const list
  (weaker, still driftable).
- **Pricing migration = monotonic integer `schemaVersion` + non-destructive merge
  + single `.bak`** — *not* the index's content-hash signature (which would
  mis-fire on every legitimate user rate edit) and *not* re-seed (which would wipe
  user edits). Merge new shipped keys, keep user overrides, back up once, log.
- **Explicitly out of scope / do-not-do** (verifier flagged these):
  - ⚠️ **Do NOT** change usage dedup to `PARTITION BY session_id, message_id` — it
    would reintroduce the ~2.4–3× cost over-count that `PARTITION BY message_id`
    (by design) prevents for fork/resume copies. See plan 0012.
  - **Do NOT** add "security" validation to analytics `from`/`to`/`groupBy` — SQL is
    parameterized via `sqlString()`; the "silent NULL" claim is false (`::TIMESTAMP`
    throws). At most a cosmetic 500→400 from the app's own frontend.
  - **Do NOT** add the "already covered" tests (orphan workflow subagent, Codex
    function_call w/o output, Junie unreadable image, pricing partial-write) or
    remove the intentional redundant `mkdirSync`.

## Approach

Five independent work items; each is its own commit and can land in any order.

### 1. Index-corruption recovery test (new `test/index-recovery.integration.test.ts`)
1. Mirror the `api.integration.test.ts` harness: `mkdtempSync` work dir; set
   `CLAUDE_PROJECTS_DIR`/`CODEX_*`/`JUNIE_*`/`DUCKDB_PATH`/`CLAUDESCOPE_HOME`/
   `REINDEX_INTERVAL_MS=0` **before** importing server modules; write one tiny
   synthetic Claude session.
2. **2a — byte corruption:** `reindex()`, capture baseline `SELECT id FROM
   sessions` + `count(*) FROM events`; `closeConnection()`; overwrite the
   `.duckdb` with ≥4KB `randomBytes` and remove the `.wal`; `vi.resetModules()`;
   re-`getConnection()` → assert `console.warn` matched `/discarding and
   rebuilding/`, it resolves, and post-`reindex()` data equals baseline.
3. **2b — stale schema:** tamper `meta.schema_signature` to a sentinel +
   `CHECKPOINT` + close; reconnect → assert the same warn fired, rebuild matches
   baseline, and `meta.schema_signature` is re-stamped to a 40-hex sha1 (≠ sentinel).
4. Per-scenario fresh `DUCKDB_PATH` + `vi.resetModules()` (module-level
   `DUCKDB_PATH`/`SCHEMA_SIGNATURE`/singleton are frozen at import; `closeConnection`
   only nulls the JS ref, so isolate paths to avoid a lingering-handle lock).

### 2. Daemon hung-state fix + first CLI test (`src/cli.ts`, new `test/cli.test.ts`)
1. In `start()`, split the post-check into three cases: healthy → return
   (unchanged); `!isAlive` → clear stale `daemon.json` (unchanged); **`isAlive &&
   !healthy` (wedged)** → log, `SIGTERM`, `await waitForExit(pid, ~5s)`, clear
   `daemon.json`, fall through to spawn; if it won't exit → actionable error,
   `exitCode = 1`, **return without spawning**.
2. Add `waitForExit(pid, timeoutMs)` (100ms poll, same idiom as `waitForHealth`).
3. Make `stop()` `async` and `await waitForExit` after `SIGTERM` before removing
   `daemon.json`; update **all three** call sites (`stop`, `restart`, `update`) to
   `await stop()` — closes the restart/update rebind race.
4. Extract a pure `classifyExisting(record, aliveFn, healthyFn): 'healthy' |
   'stale' | 'wedged' | 'none'` so the exact bug is unit-testable without spawning.
5. Testability seam: `export` the lifecycle helpers; guard the bottom `main()` call
   with `realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url))` so
   importing the module under Vitest doesn't execute a command.
6. New `test/cli.test.ts`: `classifyExisting` truth table, `isAlive`/`readDaemon`
   (valid/missing/corrupt), `isHealthy`, `waitForHealth` retry+timeout (fake
   timers), `waitForExit` — all mocking `process.kill`/`fetch`, no real server.
7. **Tier-3 fold-ins (in-file, recommended):** extract the byte-identical
   `openBrowser()` (dup in `cli.ts` + `index.ts`) into a shared util; size-cap/roll
   the append-only `daemon.log` before reopening for append.

### 3. React error boundary (`packages/web`)
1. New `components/ErrorBoundary.tsx`: class component
   (`getDerivedStateFromError` + `componentDidCatch` → `console.error`),
   `resetKeys` to auto-recover, default fallback delegates to `<ErrorBox>`.
2. Export it from `components/index.ts`.
3. Root: wrap `<Routes>` in `App.tsx` with `resetKeys={[pathname]}`
   (`useLocation`), **sidebar stays outside** so nav survives a crash.
4. Per-block: wrap `ThreadBlockView` inside `RevealableBlock` in `ThreadView.tsx`
   with a compact fallback + `resetKeys={[block]}` — keep the boundary **inside**
   the existing `.tv-block`/`data-block-id` wrapper so the in-session finder DOM
   queries still work.
5. No automated test (see Testing) — manual verification.

### 4. DB-column → shared-type guard (`packages/server/src/routes/*`, new `db/row.ts`)
1. New `db/row.ts`: `readRow(row, ctx)` → `req`/`str`/`num`/`bool`/`opt` getters;
   `req()` throws `"<ctx>: column '<k>' missing (alias drift?)"` if the key is
   absent (distinguishing absent from present-null).
2. Rewrite the mappers in `routes/sessions.ts`, `routes/projects.ts`,
   `routes/analytics.ts`, and `routes/search.ts` to read via `readRow`, preserving
   current null-defaults (e.g. `connector_id || 'claude-code'`).
3. Add a "DTO completeness (alias-drift guard)" describe to
   `api.integration.test.ts` asserting each route's DTO fields are populated to
   their expected non-defaults against the existing fixtures; add a small
   `test/row.test.ts` for the helper's absent/present-null/coercion branches.

### 5. Pricing.json versioned migration (`packages/shared`, `packages/server`)
1. Add optional `schemaVersion?: number` to `PricingConfig` (`shared/src/pricing.ts`);
   add `"schemaVersion": 1` to the shipped `packages/server/pricing.json` (flows to
   `dist/pricing.default.json` via `bundle.mjs` unchanged).
2. New `reconcileUserPricing()` in `data/pricing.ts`, called from `ensureStateDir`
   (`config.ts`) right after `mkdirSync` (already sequenced before any pricing read):
   - absent user file → copy default (current behavior; now carries version);
   - `userV >= shippedV` → **no-op** (don't rewrite — preserves mtime / loader cache);
   - `userV < shippedV` → back up to `pricing.json.bak`, deep-merge
     (`models`/`families` merged, user values win, `default` prefers user,
     `schemaVersion` stamped forward), atomic temp-then-rename write, `console.warn`
     a one-line "migrated, edits preserved, backup written" message;
   - corrupt user file → leave untouched + warn (never delete user data).
3. Tests in `pricing.test.ts` (param the default path so tests control it); update
   the README pricing section to document versioning + `.bak`.

## Files affected

- `packages/server/test/index-recovery.integration.test.ts` *(new)* — corruption + stale-schema recovery.
- `packages/server/src/cli.ts` — wedged-daemon handling, `waitForExit`, async `stop()`, exported helpers + entrypoint guard, (fold-in) shared `openBrowser` + log cap.
- `packages/server/test/cli.test.ts` *(new)* — lifecycle helper + `classifyExisting` tests.
- `packages/server/src/util/open-browser.ts` *(new, fold-in)* + `packages/server/src/index.ts` — use the shared opener.
- `packages/web/src/components/ErrorBoundary.tsx` *(new)*, `components/index.ts`, `App.tsx`, `pages/session/ThreadView.tsx` — render boundaries.
- `packages/server/src/db/row.ts` *(new)*, `routes/{sessions,projects,analytics,search}.ts` — typed row reader; `test/row.test.ts` *(new)* + `test/api.integration.test.ts` — guard coverage.
- `packages/shared/src/pricing.ts`, `packages/server/pricing.json`, `packages/server/src/config.ts`, `packages/server/src/data/pricing.ts`, `packages/server/test/pricing.test.ts`, `README.md` — pricing migration.

## Testing

- `npm test` (Vitest) and `npm run typecheck` (tsc -b) after each item.
- New/extended suites: `index-recovery.integration`, `cli`, `row`, `pricing`
  (reconcile), and DTO-completeness assertions in `api.integration`.
- **React boundary has no automated test** — the web test env is `node`-only with
  no jsdom/testing-library, and adding them is a dep decision (see open questions).
  Verified manually via `npm run dev`: force a `ThreadBlockView` branch to throw,
  confirm only that block shows the inline `ErrorBox` while the rest of the thread
  and the sidebar stay usable; navigate away to confirm the boundary resets.
- Manual negative check (PR notes, not committed): temporarily renaming a SELECT
  alias should make the new DTO-completeness assertions fail and `readRow` throw.

## Risks / open questions

- **Index test flakiness** — reopening a path with a lingering DuckDB handle can
  raise a *lock* error instead of the wanted *corruption* error; mitigated by a
  fresh `DUCKDB_PATH` per scenario. The test couples to the `console.warn` wording
  (treat that log line as load-bearing; note it in a comment).
- **`main()` entrypoint guard** is the riskiest daemon change — a wrong comparison
  would make the shipped CLI silently no-op. Mitigated with `realpathSync` on both
  sides (handles the brew/symlink case) + unchanged production launch path.
- **Daemon behavior change** — `stop()` becomes `async`; all three call sites must
  `await`. Wedged-case bails with an actionable error rather than `SIGKILL` (open
  question: is auto-`kill -9` escalation ever wanted? default: no).
- **Guard throws on drift** — routes that previously returned silent defaults now
  500 on a renamed/dropped column. Intended (loud failure); all SELECTs are
  in-repo and uniform, so `req()`-vs-`opt()` is unambiguous today.
- **Pricing merge correctness** — must deep-merge `models`/`families` or newly
  shipped keys silently won't appear (a variant of the original bug); the
  equal-version path must truly not rewrite (else every boot busts the loader cache).
  Corrupt user file is left untouched (no data loss).
- **Open — React boundary tests:** ship without (matches current node-only,
  no-new-deps setup) *or* add `jsdom` + `@testing-library/react` devDeps for a real
  render test? Default recommendation: ship without; revisit if desired.
- **Open — Tier-3 fold-ins:** include the in-file `openBrowser` extraction + log
  cap (both live in `cli.ts`, which we're already editing), or keep the diff
  strictly to the fix? Default: include (the user opted into in-file Tier-3).
