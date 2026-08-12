# 0068 — Raycast extension and deep-link CLI seam

- **Status:** in-progress
- **Date:** 2026-08-11
- **PR:** ClaudeScope: https://github.com/vladar107/claudescope/pull/89;
  Raycast Store: https://github.com/raycast/extensions/pull/30175
- **Extension repository:** https://github.com/vladar107/claudescope-raycast
- **Minimum ClaudeScope version:** 0.17.0

## Context

ClaudeScope already exposes machine-readable, read-only query commands that
start the daemon lazily. Search is capped server-side, session listings accept a
limit, and the web application has stable session/message routes at
`/sessions/:id#<message-uuid>`. This is enough data for a focused Raycast
experience without duplicating transcript parsers or talking directly to
DuckDB, agent source directories, or a hosted service.

Two integration gaps remain. Raycast may not inherit the user's interactive
shell `PATH`, so it needs safe executable discovery with an override. And
`claudescope open` can currently open only the application root of an already
running daemon; it cannot lazily start the app or open a selected session/search
hit. A small CLI deep-link contract keeps port and daemon-state knowledge inside
ClaudeScope instead of leaking it into the extension.

Public Raycast extensions are reviewed and published through the Raycast Store.
The extension therefore needs its own package/repository and Store assets rather
than becoming another workspace in the ClaudeScope monorepo. See Raycast's
[preparation checklist](https://developers.raycast.com/basics/prepare-an-extension-for-store)
and [publishing workflow](https://developers.raycast.com/basics/publish-an-extension).

## Goal

Publish a local-only Raycast extension with three commands — Search ClaudeScope,
Recent Sessions, and Open ClaudeScope — backed exclusively by the installed
ClaudeScope CLI. Selecting a transcript hit must open the exact session/message
in the user's running app, including when ClaudeScope uses a non-default port.

## Decisions

- **Keep extension code outside the ClaudeScope npm workspaces** — develop a
  dedicated `claudescope-raycast` package/repository and publish it through the
  Raycast Store workflow. This plan records the cross-repository contract; the
  Store PR owns the extension source once submitted.
- **Use the CLI, never transcript storage or DuckDB** — invoke documented
  `claudescope ... --json` commands, parse their bounded output, and leave daemon
  startup, index compatibility, and source access inside ClaudeScope. The
  extension makes no outbound requests and requires no API key.
- **Ship a deliberately small command set** — Search ClaudeScope provides
  debounced full-text results and message-level opening; Recent Sessions lists
  and filters the latest sessions; Open ClaudeScope launches the main UI. Do not
  add resume, fork, delete, prompt execution, dashboards, or transcript parsing
  to the first Store submission.
- **Add one stable deep-link seam** — extend the CLI to accept
  `claudescope open --session <id> [--around <message-uuid>]`. `open` should
  ensure the daemon is available, validate its port, construct a loopback-only
  URL, encode path/fragment values, and preserve plain `claudescope open` as
  the root-app form. `--around` without `--session` is a usage error.
- **Resolve and execute the binary safely** — prefer an optional executable-path
  preference, otherwise discover `claudescope` through the user's login shell.
  Validate the resolved executable and always pass search text and identifiers
  as argv elements; never interpolate them into a shell command.
- **Treat the published CLI version as a dependency** — merge and release the
  deep-link command before Store publication, document the minimum compatible
  ClaudeScope version, and show an update/install action when the binary is
  absent or too old.
- **Keep Store data local and transparent** — declare macOS support, explain
  that transcript snippets are rendered locally, include no telemetry, and
  provide actions to open the result in ClaudeScope or copy non-secret metadata.

## Approach

1. **ClaudeScope deep-link contract (simple; no prerequisites)** — update the
   `open` command to ensure the daemon, accept `--session` plus the existing
   `--around` value, construct encoded session URLs from a validated loopback
   port, and update CLI help and user documentation.
   Acceptance: plain `open` still opens the app root; a session id opens
   `/sessions/<encoded-id>`; an anchor adds an encoded fragment; stopped daemons
   start safely; custom running ports are preserved; invalid flag combinations
   fail before opening a browser.
2. **Extension foundation (complex; can begin alongside 1)** — create the
   standard Raycast TypeScript/React package with MIT metadata, a custom icon,
   npm lockfile, macOS platform declaration, executable preference, minimal
   local response types, and a shared argv-based ClaudeScope client. Normalize
   missing binary, non-zero exit, malformed JSON, indexing, and incompatible
   version errors into actionable Raycast states.
   Acceptance: the extension resolves npm, Homebrew, and Nix-style installations
   or honors the explicit path; user input never reaches a shell string; no
   direct filesystem-source or network access exists.
3. **Three-command MVP (complex; depends on 2, exact opening depends on 1)** —
   implement debounced transcript search, a recent-session list with local
   filtering, and a no-view open command. Add actions to open the exact hit or
   session, open the ClaudeScope root, copy a session id/snippet, retry, and open
   extension preferences when setup is incomplete.
   Acceptance: result titles, agent, project, date, snippet, tokens/cost, and
   empty/error/loading states render clearly; queries remain responsive; every
   selected result opens the expected ClaudeScope route.
4. **Store presentation and local validation (simple; depends on 2-3)** — write
   a concise README/privacy section and changelog, prepare Store-sized icon and
   screenshots using synthetic or scrubbed data, and run Raycast's lint/build
   checks plus manual installation from source.
   Acceptance: Store metadata differentiates ClaudeScope as multi-agent,
   read-only, local transcript search; screenshots expose no private paths or
   conversation text; the extension passes current Store checks.
5. **Release and publication handoff (external; depends on 1-4)** — merge and
   publish a ClaudeScope release containing the deep-link seam, verify that
   npm/Homebrew/Nix users can update to it, then run Raycast's publish command to
   open the Store PR. Keep both PR URLs and the final minimum version in this
   plan. Tagging/releasing ClaudeScope and opening the external Store PR require
   explicit maintainer authorization at their respective steps.
   Acceptance: the public extension installs from the Store, operates against
   the documented ClaudeScope version, and its Store source/review link is
   recorded here and in the user-facing README.

## Files affected

ClaudeScope repository:

- `packages/server/src/cli.ts` — lazy root/session/message opening and CLI flag
  validation.
- `README.md` — deep-link command and Raycast installation/documentation once
  the Store listing exists.
- `docs/plans/0068-raycast-extension.md` — this cross-repository plan; keep
  status, versions, and both PR links current.
- `docs/plans/README.md` — plan index entry.

External [`claudescope-raycast`](https://github.com/vladar107/claudescope-raycast)
package/repository:

- `package.json` and `package-lock.json` — Raycast manifest, commands,
  preferences, platform, scripts, and locked dependencies.
- `src/lib/claudescope.ts` — executable discovery, argv execution, JSON parsing,
  compatibility checks, and shared error mapping.
- `src/search-claudescope.tsx` — debounced transcript-search list and actions.
- `src/recent-sessions.tsx` — recent-session list, filtering, metadata, and
  actions.
- `src/open-claudescope.ts` — immediate root-app launcher.
- `assets/extension-icon.png` and Store screenshots — non-default, privacy-safe
  presentation assets.
- `README.md` and `CHANGELOG.md` — setup, privacy, minimum version, usage, and
  version history.

## Testing

1. Build ClaudeScope and manually verify `open`, `open --session`, and
   `open --session --around` against a temporary/synthetic ClaudeScope home,
   stopped and running daemons, encoded identifiers, and a non-default port.
2. Run the existing ClaudeScope checks: `npm test`, `npm run typecheck`,
   `npm run build`, `npm run bundle`, `git diff --check`, and a final code-review
   pass. Do not add automated tests unless the maintainer explicitly requests
   them.
3. In the Raycast package, run the current scaffold's lint and production-build
   commands, import the extension locally, and exercise all commands with:
   normal results, no results, rapid query changes, missing/incorrect executable
   paths, stopped/indexing daemons, malformed/non-zero CLI output, and the
   minimum supported ClaudeScope version.
4. Verify deep links with npm, Homebrew, and Nix-style executable locations
   where available; otherwise simulate the resolved absolute paths and document
   which install methods received live verification.
5. Inspect the final extension bundle, manifest, screenshots, and Store PR for
   accidental network clients, telemetry, secrets, private transcript text, or
   direct agent-source access.

## Implementation status

- ClaudeScope PR [#89](https://github.com/vladar107/claudescope/pull/89) merged,
  and ClaudeScope 0.17.0 released the lazy root/session/message opening contract.
  Tests, typecheck, build, bundle, and safe manual checks passed, including
  validation-before-startup, encoded identifiers, a stopped daemon, and a
  running daemon on a custom port.
- The standalone
  [`vladar107/claudescope-raycast`](https://github.com/vladar107/claudescope-raycast)
  repository contains the three-command extension, executable discovery and
  preference override, local-only CLI client, user-facing setup errors,
  ClaudeScope-aligned agent labels, and project display names. TypeScript,
  Raycast lint, and production build checks pass, and all three commands were
  exercised locally against ClaudeScope 0.17.0.
- Two privacy-safe Store screenshots were captured with synthetic transcript
  data. The Raycast submission includes a complete description, screenshots,
  and completed publishing checklist in Store PR
  [#30175](https://github.com/raycast/extensions/pull/30175).
- This plan remains in progress only for the Store publication lifecycle. Store
  PR #30175 is open as a draft and must be marked ready for review. Mark the
  plan done, update the plan index, and add the live Store URL after Raycast
  merges the submission and the public installation is verified.

## Risks / open questions

- The Raycast `author` field is confirmed as `vladar107` and validated by the
  current Raycast manifest linter.
- Raycast's process environment may not include the interactive shell `PATH`.
  Discovery must fail clearly and the explicit executable preference must
  always win.
- CLI JSON is a documented scripting surface but not a separately versioned
  SDK. Parse only the fields used by the UI, tolerate additional fields, and
  keep a clear minimum-version boundary.
- Live search starts a short CLI process after a debounce. Avoid firing on empty
  or very short input and discard stale responses so typing cannot reorder the
  results.
- Store PR [#30175](https://github.com/raycast/extensions/pull/30175) may receive
  requests for metadata, screenshots, or implementation changes.
  Keep those changes in the external extension unless they expose a genuine
  ClaudeScope integration-contract problem.
- The ClaudeScope release and initial Raycast submission are complete. Any
  review-driven Store update remains an external change and should stay in the
  standalone extension or Raycast Store PR unless it changes the CLI contract.
