# 0082 — Brew release waits for the npm tarball

- **Status:** done
- **Date:** 2026-09-04
- **PR:** https://github.com/vladar107/claudescope/pull/106

## Context

The `brew` job in `release.yml` downloads the freshly published tarball from
`registry.npmjs.org` to compute the `sha256` for the Homebrew formula. Since
late August 2026 the registry serves a new tarball only **5–15 minutes after
`npm publish` returns** — before that the URL is a 404. The job starts about
3 seconds after `npm` finishes, so `curl -f` fails with
`curl: (22) The requested URL returned error: 404` and the channel is left
un-updated. Releases 0.19.1 and 0.20.0 both needed a **manual re-run** of the
brew job (24 min and ~3 h later, respectively); a re-run 1.5 min after publish
still failed.

Facts that shape the fix:

- The repo is **public**, so GitHub-hosted runner time is not billed — the
  Actions timing API reports 0 billable minutes for the release runs. Waiting
  costs nothing.
- The registry serves **exactly the bytes npm hashed at publish time** (for
  0.20.0 the registry tarball's sha1 equals the `shasum` printed by
  `npm publish`), so hashing before publishing would also be viable — it is just
  not needed.

## Goal

A tag push updates the Homebrew formula with the correct `sha256` and no human
intervention, as long as the registry propagates the tarball within ~30 minutes.

## Decisions

- **Poll for the tarball in the `brew` job** — rather than (a) hashing `npm pack`
  output in the `npm` job and passing it as a job output, which is fast but
  leaves the formula pointing at a URL that 404s for 5–15 min and adds a second
  hash path to keep straight, or (b) attaching the tarball to the GitHub Release
  and pointing the formula there, which breaks the documented "channels wrap the
  npm package, no separate artifacts" model. Waiting keeps the formula's `sha256`
  derived from the bytes the registry actually serves, and the wait is free.
- **`curl --retry 60 --retry-delay 30 --retry-all-errors`** on top of the
  existing `-fsSL` — plain `--retry` never retries a 4xx; `--retry-all-errors`
  together with `-f` does. A fixed 30 s delay (instead of curl's exponential
  backoff, which climbs to 10 min per retry) means the job proceeds within 30 s
  of the tarball appearing, and 60 retries bound the wait at ~30 min. Verified
  locally: a 404 is retried each interval, `-S` prints one line per attempt to
  the job log, a 200 is not retried, and exhausted retries exit non-zero (56,
  not 22 — under `--retry-all-errors` curl reports HTTP errors as transient).
- **`timeout-minutes: 45` on the job** — a hard cap so a hung connection cannot
  hold the runner for the default 6 h. Propagation slower than 30 min still
  fails the job, and the existing remedy (re-run just that job) still applies.
- **No `CLAUDE.md` change** — the inline comment in `release.yml` is what stops
  someone "simplifying" the curl line back to a single fetch; `CONTRIBUTING.md`
  gets one sentence on the expected release duration.

## Approach

1. `release.yml`, `brew` job: add the retry flags to the tarball fetch with a
   short comment on why, add `timeout-minutes: 45`, and update the header
   comment ("brew runs after npm …") and the job comment to say brew waits for
   the registry.
2. `CONTRIBUTING.md`, release-workflow paragraph: note that `brew` polls for
   the tarball (up to ~30 min), so a release takes 10–30 min end to end and
   needs no re-run; keep the "re-run that job" advice for real failures.
3. Commit as `ci:` (the type this repo uses for workflow changes), open the PR,
   then set this plan to `done` with the PR link.

Small enough to do directly — no subagent waves.

## Files affected

- `.github/workflows/release.yml` — `brew` job: retrying curl, job timeout,
  comments.
- `CONTRIBUTING.md` — release-workflow paragraph.
- `docs/plans/0082-brew-release-waits-for-npm-tarball.md`,
  `docs/plans/README.md` — this plan and its index row.

## Testing

- `actionlint .github/workflows/release.yml` passes.
- curl semantics checked locally against the real registry (done during
  planning): 404 → retried with a log line per attempt, non-zero exit when
  exhausted; 200 → a single request.
- The real check is the **next release**: the `brew` job must succeed on
  attempt 1, finishing 5–25 min after `npm`, and the tap formula's `sha256`
  must equal `shasum -a 256` of the registry tarball.

## Risks / open questions

- Propagation slower than 30 min fails the job exactly as today; bump
  `--retry` if that ever happens.
- Transient 5xx / connection errors on the fetch are now retried too, where
  they previously failed the job outright.
- If the repo ever goes private, the wait counts against the 2,000-minute
  monthly quota; switch to hashing the `npm pack` output in the `npm` job (see
  Decisions) at that point.
