# 0096 — Back off retries of unchanged transcripts that failed to load

- **Status:** done
- **Date:** 2026-11-02
- **PR:** https://github.com/vladar107/claudescope/pull/129

## Context

A file whose `loadFile` fails never advances its `files` bookkeeping, so every
auto-reindex pass retried it. One 851 MB transcript failed with a DuckDB
out-of-memory error on each pass, holding the shared connection for 5-13 s
every 15 s and queueing every HTTP route behind it (thousands of identical
log lines).

## Decisions

- Remember a failed load in memory, keyed by path with the (mtime, size) it
  failed at, plus `attempts` and `retryAtMs`. A restart retries once, which is
  acceptable.
- Backoff, not skip-until-changed: a transient failure (permissions, a file
  locked mid-write, a one-off out-of-memory) must recover without the file
  changing. After a failure the delay is `min(1 min * 2^(attempts-1), 1 h)`.
- A pass skips the file while its (mtime, size) are unchanged and the retry is
  not yet due. A change retries immediately and resets `attempts`; a success
  deletes the entry; a full rebuild clears the memory; entries for paths that
  vanish from discovery are forgotten (unless their connector's discovery
  failed this pass, which is transient).
- Reporting: every attempt that fails is counted in `failed` and logged, so
  the warning appears once per attempt instead of every pass. Skipped passes
  report `failed: 0` and stay cheap.
- The idle early-return is untouched, so `derivedDirty` is still honoured.

## Tests

`index-durability.integration.test.ts`: a failed unchanged file is skipped,
retried once the backoff expires (via `expireFailedLoadBackoffForTests`), and
retried immediately after a change. The existing recovery test only gained a
call to that hook.
