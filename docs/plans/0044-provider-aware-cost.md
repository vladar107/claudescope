# 0044 — Provider-aware cost: local vs remote model sessions

- **Status:** done
- **Date:** 2026-07-13
- **PR:** https://github.com/vladar107/claudescope/pull/56

## Context

A pi session run against a **local** LM Studio model (`openai/gpt-oss-20b`)
showed **$0.081** in Claudescope. Root cause: cost is computed at index time as
tokens × rates resolved by exact model id → family substring → default
(`buildCostExpr`, `packages/server/src/data/index.ts`). `openai/gpt-oss-20b` has
no exact/fetched rate (the LiteLLM fetcher skips slash-prefixed ids) but
matches the `gpt` **family** ($2.50/M in, $15/M out) → phantom cost for a free
local run.

The pricing path had no concept of *where* a model ran. Decisions locked with
the user before implementation:

- Keep the uniform "store tokens, compute cost from pricing config at index
  time" design — never trust agent-reported cost (pi's own `usage.cost` stays
  ignored).
- Add a per-assistant-event `provider` column and a `providers` rate-override
  section in pricing config; known local runtimes zero-rate.
- **No retroactive re-costing.** Pricing changes apply prospectively (to newly
  indexed files) — the existing, accepted trade-off. Historical costs stay as
  stamped at index time; a full re-price happens only when the derived index
  is rebuilt (schema bump on upgrade, corruption recovery, or deleting
  `~/.claudescope/index.duckdb`). The README's previous "re-index recomputes
  stored costs" claim was wrong and is corrected here to describe this.

## Goal

A session run entirely on a local model provider shows **$0** and is visibly
tagged **local** everywhere cost is surfaced (API, UI, CLI, MCP) — without ever
retroactively re-pricing history that's already indexed.

## Decisions

- **Provider signal varies by agent** — pi (`message.provider`, per-message,
  sessions can mix providers), Codex (`session_meta.model_provider`,
  session-level, applied to every assistant row), and opencode (`providerID`,
  per-message) all record it. Junie, Copilot CLI, Claude Code, and Antigravity
  record no provider at all — local runs there can't be auto-detected; the
  escape hatch is pinning the exact model id to a zero rate in `pricing.json`'s
  `models` section.
- **Seed a known-local set, but stay user-extensible.** Arbitrary custom
  provider ids exist (Codex TOML keys, pi `models.json`, opencode config), so
  the shipped default zero-rates nine known local-runtime ids (`ollama`,
  `lmstudio`, `lm-studio`, `llama.cpp`, `llamacpp`, `vllm`, `oss`, `local`,
  `mlx`) and falls through to model pricing for any unknown id — a real remote
  custom gateway (e.g. Codex's `custom-gateway`) must never get zero-rated by
  accident.
- **Provider override wins outright.** When a provider matches a `providers`
  entry, that entry's rates apply and the model-id/family/default chain is
  skipped entirely — this is deliberately a full override, not a partial one.
- **`hasLocalProvider` is server-computed**, not derived client-side, so the
  local rate set is a single source of truth and clients never duplicate it.
- **DDL signature bump (schema v11)** for `events.provider` +
  `sessions.providers` triggers the one-time full index rebuild that also
  re-prices already-indexed local sessions to $0 — the intended one-time
  correction, not a general re-pricing mechanism.

## Approach

### Pricing config + connectors

- `packages/shared/src/pricing.ts`: `PricingConfig.providers?: Record<string,
  ModelRates>` (lowercase provider id → rates, matched case-insensitively,
  overrides the models/families/default chain) + exported `isZeroRated(r)`
  helper (all four rates 0).
- `packages/server/pricing.json`: `schemaVersion: 3`, seeded `providers` zero-
  rating the nine local-runtime ids above.
- `packages/server/src/config.ts`: `PRICING_SCHEMA_VERSION = 3`; the
  shipped/user reconcile merge gained a `providers` entry (previously only
  `models`/`families`/`default` were merged — a user's custom provider id now
  survives a v2→v3 migration alongside the new shipped set).
- `connectors/types.ts`: `provider` added to `CANONICAL_EVENT_COLUMNS`
  (nullable — NULL where the format records no signal). All seven connectors
  updated: pi and opencode extract it per-message; Codex captures
  `model_provider` once per session and stamps it on every assistant row;
  Junie/Copilot/Antigravity/Claude Code project `CAST(NULL AS VARCHAR)`.

### Schema + indexer (schema v11)

- `db/schema.ts`: `events.provider VARCHAR` (after `model`) and
  `sessions.providers VARCHAR` (distinct-providers CSV, same convention as
  `models`); `SCHEMA_VERSION = 11` — the DDL-signature change auto-discards and
  rebuilds the index on next start, which is also how already-indexed local
  sessions get re-priced to $0 once.
- `data/index.ts`: `buildCostExpr` wraps the existing rate chain in a `CASE
  WHEN lower(ev.provider) = '<id>' THEN <rate> …` per `pricing.providers`
  entry, falling through to the model chain via `ELSE` (NULL/unlisted
  providers never match, so unlisted-provider and no-provider events are
  unaffected); the events INSERT carries `ev.provider`;
  `rebuildSessions` aggregates `list_distinct(...) FILTER (WHERE provider IS
  NOT NULL)` into the `providers` CSV column.

### API, CLI/MCP, docs (this pass)

- `packages/shared/src/api.ts` `SessionMeta`: added `providers: string[]` and
  `hasLocalProvider?: boolean` (server-computed).
- `packages/server/src/routes/sessions.ts` `rowToSessionMeta`: splits the
  `providers` CSV like `models`; computes `hasLocalProvider` from a cached
  `loadPricing()` call + `isZeroRated` per provider.
- `packages/server/src/agent/mcp.ts` `sessionLine`: appends ` (local)` after
  the cost segment when `hasLocalProvider`; JSON outputs (CLI `--json`, the
  API) pick up the new fields automatically since they serialize `SessionMeta`
  directly — no separate CLI-side change needed.
- `README.md` "Cost methodology": documents the provider override as lookup
  step 1 (ahead of fetched/local exact id, family, default), lists the nine
  seeded local ids, notes the four agents with no provider signal, and
  rewrites the previously-false "re-index recomputes stored costs" bullet to
  describe the real prospective-pricing behavior and when a full rebuild
  actually happens.
- `CLAUDE.md` "Cost is a local estimate" gotcha: extended with the
  provider-override + prospective-pricing facts.

### UI (parallel wave, `packages/web` — not touched by this pass)

- New `components/LocalBadge.tsx` mirroring `AgentBadge`; rendered next to
  `ModelChips` in `pages/browse/SessionList.tsx` and
  `pages/session/SessionPage.tsx` when `hasLocalProvider`; a muted
  `.tv-chip--local` style in `styles/global.css`.

## Files affected

- `packages/shared/src/pricing.ts` — `providers` + `isZeroRated`.
- `packages/shared/src/api.ts` — `SessionMeta.providers` / `.hasLocalProvider`.
- `packages/server/pricing.json`, `src/config.ts` — seeded zero-rating +
  reconcile merge.
- `packages/server/src/connectors/types.ts` + all seven connectors' `*.ts` /
  `normalize.ts` — `provider` column end to end.
- `packages/server/src/db/schema.ts` (v11), `src/data/index.ts` — provider
  column + cost-expression override + `providers` session aggregate.
- `packages/server/src/routes/sessions.ts` — `rowToSessionMeta` reads
  `providers` / computes `hasLocalProvider`.
- `packages/server/src/agent/mcp.ts` — `sessionLine` `(local)` marker.
- `README.md`, `CLAUDE.md` — pricing docs.
- `packages/web/src/components/LocalBadge.tsx` (new),
  `components/index.ts`, `pages/browse/SessionList.tsx`,
  `pages/session/SessionPage.tsx`, `styles/global.css` — local badge (parallel
  wave).

## Testing

`npm run typecheck` (`tsc -b`) — clean. `npm test` — 45 files / 374 tests
passing.

Dedicated provider-pricing tests (mixed-provider session cost split, unknown-
provider fallthrough, v2→v3 reconcile preserving a custom provider id) were
part of the original plan's Wave 4 and are **not yet added** — existing fixture
suites already carry `provider`/`providerID`/`model_provider` values on assistant
rows (pi, Codex, opencode integration tests) and continue to pass unchanged,
but they predate and don't specifically exercise the zero-rating logic. See
Risks below.

## Risks / open questions

- **Wave 4 tests outstanding**: `test/pricing.test.ts` (provider beats exact-id,
  unknown provider falls through, v2→v3 reconcile keeps a custom entry),
  `pi.integration.test.ts` (mixed lmstudio/openai-codex session →
  `providers` CSV + split cost + `hasLocalProvider`), `codex.integration.test.ts`
  (`model_provider` propagates session-wide), `opencode.integration.test.ts`
  (`providers === ['openai']`) are all still to write.
- Manual end-to-end verification (start the server, confirm the v11 rebuild,
  check `/api/sessions`, the UI badge in light/dark, `claudescope sessions
  --json`, and the MCP `(local)` marker) has not been run in this pass.
