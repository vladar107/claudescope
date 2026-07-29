# 0056 — Prune the normalize cache when its source is gone

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-29
- **PR:** <link, once opened>

## Context

Fifth PR from the repo-wide review, and the one [0055](./0055-canonical-connector-contract.md)
was sequenced to unblock.

Seven connectors write the normalized session to
`~/.claudescope/cache/<agent>/<hash>.ndjson`. That file holds `text_content` for
every event — the transcript **verbatim**, including any secret that appeared in
it. Nothing ever removed one. Verified against a real index:

```text
after index   → cache: [{"f":"5be5aaac615e1f24.ndjson","bytes":1154}]
              → cache contains the transcript secret verbatim: true
after DELETE  → events in DB: 0 (correctly pruned)
              → cache: [{"f":"5be5aaac615e1f24.ndjson","bytes":1154}] ← NOT pruned
after REBUILD → cache: [{"f":"5be5aaac615e1f24.ndjson","bytes":1154}] ← still NOT pruned
              → source file exists: false
```

Three paths that all looked like they should clean up, and none did: the
indexer's removed-file prune deletes DB rows only, `discardDbFiles()` removes
`index.duckdb*` only, and no CLI command touches the cache. So deleting a session
from `~/.codex` left Claudescope's plaintext copy on disk indefinitely — which
contradicts the read-only-viewer framing — and the directory only ever grew.

## Goal

A cache entry does not outlive the source file it was derived from, and orphans
already on disk are cleaned up too.

## Decisions

- **Sweep, don't delete-on-removal** — the precise fix is to unlink the entry as
  its source disappears in the removed-file loop. A sweep (keep exactly the
  entries the live source set hashes to; delete the rest) is the same size and
  also heals orphans already on disk: from versions before this change, and from
  a crash between `prepare()` and the load. The sweep subsumes the precise case.
- **Own it in `ndjson-cache.ts`, not on the connector port** — the indexer knows
  each file's `connector.id` but not its cache path. Exposing `cachePath()` on
  `AgentConnector` would leak the layout onto the port, and a per-connector
  `prune()` would reintroduce the seven copies 0055 just removed. The cache
  module already owns the naming rule, so it owns the sweep.
- **Run it every pass, not only passes with work** — a handful of `readdir`s over
  small directories, dwarfed by the hundreds of `stat`s discovery already does.
  Gating it on "something changed" would leave pre-existing orphans until the next
  real edit for no meaningful saving.
- **Exclude a connector whose `discover()` threw** — the interesting edge. The
  indexer already preserves such a connector's indexed sessions because the
  absence is transient; its cache needs the same protection, or a flaky source
  would delete the very entries it is about to need. Encoded as "an agent absent
  from the live map is skipped entirely", which makes the caller's intent explicit
  rather than passing an empty list.

## Approach

1. `connectors/ndjson-cache.ts` — extract `cacheFileName()` as the single naming
   rule and add `pruneNdjsonCaches(live)`.
2. `data/index.ts` — build the live map from `discovered`, skipping
   `failedConnectors`, and sweep right after discovery.
3. Tests — the deletion path, the orphan sweep, the do-not-touch-live-entries
   guard, and the connector-failure isolation.

## Files affected

- `packages/server/src/connectors/ndjson-cache.ts` — `pruneNdjsonCaches`.
- `packages/server/src/data/index.ts` — build the live map and sweep.
- `packages/server/test/cache-prune.integration.test.ts` — new.
- `CLAUDE.md` / `SECURITY.md` — the cache and its retention rule.

## Testing

- `npm test` (554 → 559), `npm run typecheck`, `npm run build`, markdownlint.
- The tests assert the secret is present while the session exists and **absent**
  after it is deleted, so they check the actual property that matters rather than
  a file count.
- Regression-checked both ways: removing the sweep fails 3 cases; sweeping without
  the failed-connector exclusion fails the isolation case.
- A "keeps the entry for a source that still exists" case guards the catastrophic
  failure mode — only CHANGED files are re-`prepare()`d, so a wrongly-pruned entry
  would leave the projection reading a missing file.

## Risks / open questions

- An agent whose source directory is temporarily absent (unmounted, renamed)
  discovers zero files rather than throwing, so its cache is swept. That matches
  what already happens to its indexed sessions in the same situation, so the two
  stay consistent — but it means a re-mount pays a re-normalize.
- The sweep only removes `*.ndjson`. Anything else under `cache/<agent>/` is left
  alone, so an unrelated file dropped there is never deleted.
- No CLI escape hatch was added (`claudescope cache clear`): the sweep makes it
  unnecessary, and the state dir is already documented as safe to delete wholesale.
