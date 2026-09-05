# 0086 — Audit fixes and fitness functions

- **Status:** done
- **Date:** 2026-09-05
- **PR:** <https://github.com/vladar107/claudescope/pull/110>

## Context

A full audit of the codebase (architecture, code quality, workarounds, bugs,
gaps) found that the code is mature and well documented, with two clusters of
real defects:

- **Analytics derivation.** Claude Code writes one JSONL row per content block,
  all sharing one `message.id` and repeating the full `usage` object. The
  `usage_canonical` election dedups *tokens* correctly, but several routes also
  applied it to `tool_use_count`, which lives on specific block rows. Measured
  on a real index: the tools route counted 4974 Claude Code calls, the errors
  and agents routes 2728; the shown error rate was 4.8% against a true 2.7%.
  The parser summed subagent usage per row (3.84× inflation on a real run).
  Codex shell failures never carried `is_error`; pi reported a fabricated 0.
- **DuckDB lifecycle.** `getConnection` treated *every* open failure as
  corruption and deleted the index — including a lock held by another process
  (a second `npm run dev` beside the daemon, or two `claudescope mcp` spawns)
  and a failed extension download. The server had no shutdown handler, so
  DuckDB was never closed cleanly. Extensions were silently downloaded into
  `~/.duckdb`, contradicting the documented "writes only inside the state
  dir" guarantee.

Smaller items: a finalize failure left derived tables stale until the next
file change; agent-specific literals leaked into `data/` and `routes/`; the
FTS index relied on a connection-wide relaxation of a DuckDB safety setting;
interval env vars were unvalidated; two CLI error paths printed stack traces;
plus a handful of web and wording nits.

The shared indexer/route DuckDB connection was reviewed and deliberately kept
as is — it is the documented design, not a defect.

## Goal

Fix every audit finding except the shared-connection design, and land each
fix with a *fitness function*: a test that encodes the rule the bug broke, so
the same class of defect cannot return silently.

## Decisions

- **Counting rules are named SQL fragments, not inline filters.** Token and
  cost sums filter on `usage_canonical`; tool-call counts exclude fork copies
  (`forked_from_session_id IS NULL`) and never use the usage election. One
  cross-route test asserts all consumers agree on a per-block-split fixture.
  `sessions.tool_call_count` switches to the fork-excluded sum for consistency.
- **Error signal is a declared capability.** `agent-capabilities.ts` lists the
  connectors whose format carries a tool-error flag; a conformance test
  asserts declared-vs-emitted nullness for every registered connector, so a
  connector can neither fabricate a zero nor silently drop a real flag.
- **Discard only on evidence of corruption.** `getConnection` classifies the
  open error: the stale-schema sentinel and DuckDB storage/WAL corruption
  rebuild; a lock conflict or an extension-install failure rethrows with a
  clear message and leaves the file alone.
- **DuckDB extensions live under the state dir** (`<state>/duckdb-extensions`,
  override `DUCKDB_EXTENSION_DIR`). Existing users re-download ~30 MB once;
  in exchange the SECURITY.md containment claim becomes true. Tests pin the
  shared `~/.duckdb/extensions` cache via the vitest config so CI does not
  download per test file. Verified while implementing: DuckDB fetches the
  extensions over plain HTTP (signature-verified, not TLS), which README and
  SECURITY.md now state. Rejected: documenting `~/.duckdb` and leaving it.
- **FTS gets a unique document key** (`events.doc_id = hash(file_path, uuid)`,
  schema v22) so `scalar_subquery_error_on_multiple_rows` can stay at its
  default. Costs one index rebuild on upgrade; the connection-wide relaxation
  masked genuine multi-row scalar-subquery bugs everywhere. Rejected: keeping
  the setting.
- **Agent knowledge stays behind the seam.** Availability notes and the
  interrupt / PR-link / subagent-share capabilities move into
  `agent-capabilities.ts`; Codex's fallback-title stripping becomes a
  connector hook. An architecture test scans `src/data/` and `src/routes/`
  for connector-id literals.
- **Graceful shutdown drains for at most 4 s**, staying under the CLI's 5 s
  exit wait, then closes Fastify and DuckDB so a clean stop leaves no WAL.

## Approach

Waves keep parallel work on disjoint files.

1. **Wave 1** — counting rules (analytics routes + `rebuildSessions`),
   parser dedup of subagent totals, connector error signals (Codex exec exit
   codes, pi error flag, capability set), interval/CLI validation, web and
   wording nits with `nosniff` / `Referrer-Policy` headers.
2. **Wave 2** — open-failure classification + extension dir, finalize dirty
   flag, graceful shutdown.
3. **Wave 3** — agent knowledge behind the seam + architecture test.
4. **Wave 4** — FTS unique document key (schema v22), remove the setting.
5. **Wave 5** — this plan, CLAUDE.md anti-regression rules, `/review`,
   `npm test`, `npm run typecheck`, markdownlint.

## Fitness functions

1. Per-block split fixture; tools, errors, agents, efficiency, digest, and
   session meta report the same tool count; tokens count once.
2. Parser: subagent run totals equal one message's usage on split rows.
3. Error-signal conformance across every registered connector.
4. Open-failure classifier on real messages; a child process holding the
   index makes `getConnection` reject without deleting the file.
5. Injected finalize failure is repaired by the next idle pass.
6. Shutdown sequence with injected deps; a clean close leaves no `.wal`.
7. No connector-id literal under `src/data/` or `src/routes/` outside the
   capability map.
8. Scalar-subquery setting at default; FTS key unique on the forked fixture.
9. Extension directory resolves under the state dir by default.
10. Interval env parsing; offline `update`; unknown flags are usage errors.

## Files affected

- `packages/server/src/data/analytics-metrics.ts`, `routes/analytics-*.ts`,
  `data/index.ts` — counting rules and their consumers.
- `packages/server/src/data/parser.ts` — subagent usage dedup.
- `packages/server/src/connectors/codex/normalize.ts`, `pi/normalize.ts`,
  `data/agent-capabilities.ts` — error signals and the capability set.
- `packages/server/src/db/duckdb.ts`, `config.ts`, `vitest.config.ts` —
  open-failure classification, extension directory.
- `packages/server/src/data/index.ts` — finalize dirty flag.
- `packages/server/src/shutdown.ts` (new), `index.ts`, `daemon.ts` — clean
  shutdown.
- `packages/server/src/connectors/types.ts`, `codex/codex.ts`,
  `claude-code/claude-code.ts`, `data/memory.ts`, `routes/sessions.ts`,
  `routes/analytics-agents.ts`, `routes/analytics-errors.ts`,
  `routes/analytics-sessions.ts`, `routes/analytics-digest.ts` — seam.
- `packages/server/src/db/schema.ts`, `routes/search.ts` — FTS doc key.
- `packages/server/src/cli.ts`, `config.ts` — validation and error paths.
- `packages/web/src/pages/search/SearchPage.tsx`,
  `status/StatusProvider.tsx`, `packages/server/src/security.ts`,
  `scripts/bundle.mjs` — web and hygiene nits.
- `packages/server/test/*` — the fitness functions above.
- `README.md`, `SECURITY.md`, `CLAUDE.md` — extension dir, rules.

## Testing

`npm test` and `npm run typecheck` green (final: 78 files / 807 tests, up from
72 / 759); each new test was run against the pre-fix code and failed there
before the fix landed. Measured checks against the live
daemon after rebuild: errors/agents tool counts equal the tools route;
subagent headers show deduped totals; `SELECT current_setting(
'extension_directory')` points under `~/.claudescope`.

## Risks / open questions

- Schema v22 forces a one-time rebuild for every user (seconds to minutes).
- Existing users re-download DuckDB extensions once into the state dir.
- pi's tool-result error field must be confirmed against its message type;
  if absent, pi is declared as having no signal and emits NULL.
- Deferred to a follow-up plan: sessions-list pagination, Codex incremental
  prepare and per-file context re-walk, FTS rebuild debouncing (part of the
  shared-connection topic).
