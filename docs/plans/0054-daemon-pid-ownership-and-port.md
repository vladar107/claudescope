# 0054 — Don't SIGTERM a PID we don't own; validate the port

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-29
- **PR:** <link, once opened>

## Context

Third PR from the repo-wide review (after [0052](./0052-indexer-durability-and-state-perms.md)
and [0053](./0053-validate-query-params.md)). Two process-lifecycle defects, both
in `daemon.ts`/`cli.ts`.

**1. A recycled PID gets SIGTERMed.** `classifyExisting` decides what to do with
`daemon.json` from two signals: is the PID alive, and does its recorded port
answer `/api/health`. Alive-but-unhealthy is classified `wedged`, and both
`start()` and `ensureDaemon()` respond by SIGTERMing it to free the port. After a
crash (the record is left behind) plus PID reuse, that PID belongs to **an
unrelated process** — and we signal it. Confirmed with the real classifier:

```text
classifyExisting({pid: 424242, port: 4317}, alive=true, healthy=false)
→ 'wedged'   → terminateDaemon() SIGTERMs pid 424242
```

Low probability, but the consequence is killing something that isn't ours, and
`daemon.json` already carries enough context to do better.

**2. `--port` is unvalidated.** `cli.ts` does `values.port ? Number(values.port)
: DEFAULT_PORT`, so:

```text
--port abc    → NaN    → ERR_SOCKET_BAD_PORT, daemon dies instantly
--port 99999  → 99999  → ERR_SOCKET_BAD_PORT, daemon dies instantly
--port -1     → -1     → ERR_SOCKET_BAD_PORT, daemon dies instantly
--port 0      → 0      → binds a RANDOM port; health checks then never match
```

In every case `daemon.json` records the bad value (`NaN` serializes to `null`)
and the CLI waits the full 20s health timeout before printing "Server did not
become healthy in time", which describes a symptom and not the cause. The same
value reaches the server through the `PORT` env var, which `config.ts` also does
not validate.

## Goal

Claudescope never signals a process it cannot confirm is its own daemon, a bad
port is rejected before anything is spawned, and a daemon that dies on startup
says why instead of timing out silently.

## Decisions

- **Verify ownership before signalling; when in doubt, don't** — a new `owns`
  probe inspects the PID's command line (`ps` on POSIX, PowerShell
  `Get-CimInstance` on Windows) and returns `true` / `false` / `'unknown'`:
  - `true` → terminate, exactly as today;
  - `false` → the PID was recycled, so the record is stale: delete it, signal
    nothing, and carry on to spawn;
  - `'unknown'` → refuse to signal and tell the user which PID to inspect.
    Killing a process we cannot identify is worse than failing loudly.
  Rejected: comparing process start time (no Node API for an arbitrary PID, and
  parsing `ps -o lstart` is brittle) and dropping the wedged self-heal entirely
  (it is a real feature — a hung daemon should get replaced).
- **Match the command line on `claudescope`, not just the exact entry path** —
  after an upgrade or a brew/nix relocation, the running daemon's path may differ
  from this CLI's `SERVER_ENTRY`. A false `false` is safe (we don't kill, we hit
  `EADDRINUSE` instead); a false `true` is not.
- **`owns` goes on `DaemonProbes`** — the existing seam that lets the CLI tests
  cover this without spawning or killing anything (`classifyExisting`
  precedent). `start()` in `cli.ts` gets the same treatment.
- **Reject port `0` rather than treating it as "any port"** — the CLI records the
  requested port in `daemon.json` and polls it for health, so an OS-assigned port
  can never be discovered. It is a bad value here even though it is legal to
  `listen()` on.
- **An invalid `PORT` env var warns and falls back** rather than throwing —
  `config.ts` is imported at module load by the CLI, the server, and the MCP
  entry, so throwing there would break unrelated commands. The CLI flag, which is
  a direct user action, does hard-fail.
- **On health timeout, print the tail of the daemon log** instead of changing
  `spawnDaemon`'s signature to report early exit. Same diagnostic value, no churn
  through `DaemonProbes`, and it covers every startup failure (bad port, port in
  use, corrupt index) rather than just the ones we predicted.

## Approach

1. `daemon.ts`: add `daemonOwnsPid()`, put it on `DaemonProbes` as `owns`, and
   gate the `wedged` branch of `ensureDaemon()` on it.
2. `cli.ts`: same gate in `start()`; validate `--port` via the existing
   `UsageError` path; print the log tail when health never arrives.
3. `config.ts`: validate the `PORT` env var, warn and fall back to 4317.
4. Tests: ownership verdicts drive the right action, a recycled PID is never
   signalled, and every bad `--port` value is rejected before a spawn.

## Files affected

- `packages/server/src/daemon.ts` — `daemonOwnsPid`, `owns` probe, gated wedge.
- `packages/server/src/cli.ts` — port validation, gated wedge, log tail on failure.
- `packages/server/src/config.ts` — validate `PORT`.
- `packages/server/test/cli.test.ts` — ownership + port cases.

## Testing

- `npm test`, `npm run typecheck`, `npm run build`, markdownlint.
- New cases assert `terminate` is NOT called when `owns` returns `false` or
  `'unknown'`, that it IS called when `owns` returns `true` (no regression to the
  wedged self-heal), and that a `false` verdict clears the stale record and still
  spawns.
- Port cases go through the real arg parsing so a rejected value provably never
  reaches `spawnDaemon`.
- Regression check: reverting each gate must fail the new tests.

## Risks / open questions

- `daemonOwnsPid` shells out (`ps` / PowerShell). It runs only in the rare wedged
  branch, is bounded by a short timeout, and any failure degrades to `'unknown'`
  (refuse to signal) rather than throwing.
- The Windows path uses PowerShell, which is slower (~hundreds of ms). Acceptable
  for a branch that only fires when a daemon is hung.
- Refusing to signal on `'unknown'` means `claudescope start` can now fail where
  it previously (dangerously) succeeded. The message names the PID and the manual
  command, which is the correct trade.
