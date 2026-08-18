# 0071 — Runtime and query validation fixes

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-08-18
- **PR:** https://github.com/vladar107/claudescope/pull/92

## Context

A repository review found three correctness gaps and one documentation drift:

1. The npm package advertises Node.js 22.12 support, but the bundled server
   statically imports `node:sqlite`, which still required
   `--experimental-sqlite` in Node 22.12 and became unflagged in 22.13. CI's
   floating `22` entry tests the latest Node 22 rather than the declared floor.
2. Date-bound validation uses `Date.parse` as a calendar check, but JavaScript
   normalizes values such as `2026-02-31`. The original invalid string then
   reaches DuckDB and can produce a conversion error instead of the intended
   `400`. The activity `today` anchor can similarly normalize to another day.
3. Analytics and search routes cast arbitrary query strings to TypeScript enum
   types. Invalid analytics grouping can expose raw project paths, while invalid
   search type/scope values broaden the result set.
4. Package/Nix descriptions and `SECURITY.md` do not reflect all current
   connectors, and the security policy calls default outbound endpoints
   hardcoded even though the LiteLLM URL is configurable.

The dependency graph and security scanners are currently clean, so dependency
upgrades and unrelated bundle optimization are deliberately out of scope.

## Goal

Advertise a runtime floor the package actually supports, reject impossible
dates and unsupported API enum values at the server boundary, and make the
published/security metadata match the current connector set.

## Decisions

- **Require Node.js 22.13.0** — this is the first Node 22 release where
  `node:sqlite` no longer needs the experimental flag. Keeping the static import
  preserves the simple connector registry and makes the package requirement
  honest.
- **Test the exact minimum runtime** — CI will use `22.13.0`, not floating `22`,
  so a future floor regression is observable.
- **Validate the calendar without normalizing input** — a shared day validator
  checks month length and leap years, while accepted timestamp strings continue
  to flow to DuckDB unchanged. Invalid `from`/`to` values remain `400`; invalid
  optional `today` values remain ignored.
- **Reject invalid API enums with `400`** — direct HTTP callers receive a useful
  contract error instead of silently broadened or malformed results. Existing
  web, CLI, and MCP callers already send allowlisted values.
- **Prefer connector-neutral package descriptions** — the README and security
  policy remain the explicit connector inventory, avoiding routine metadata
  drift when another connector is added.

## Approach

1. Raise the root/package-lock engine floor to `>=22.13.0`; update user,
   contributor, and plugin requirements; pin CI's floor leg to `22.13.0`.
2. Add shared calendar and enum validators in `packages/server/src/params.ts`.
   Use them in analytics and search routes without changing valid-query output.
3. Extend existing integration tests for month-valid/day-impossible dates,
   leap-day behavior, the optional `today` fallback, and invalid enum values.
4. Make package and Nix descriptions connector-neutral, add missing search
   keywords, and complete/correct the connector and network inventory in
   `SECURITY.md`.
5. Run focused tests, then the complete test/typecheck/build/bundle/package,
   dependency, formatting, and Nix validation sequence. Review the final diff
   before handoff.

## Files affected

- `package.json`, `package-lock.json` — runtime floor and package metadata.
- `.github/workflows/ci.yml` — exact minimum-Node CI leg.
- `README.md`, `CONTRIBUTING.md` — npm runtime requirement.
- `plugins/claudescope/README.md`, `plugins/claudescope/skills/history/SKILL.md`
  — keep plugin installation guidance aligned.
- `packages/server/src/params.ts` — strict calendar and enum validators.
- `packages/server/src/routes/analytics.ts`, `packages/server/src/routes/search.ts`
  — validate public query values before use.
- `packages/server/test/query-params.integration.test.ts` — date and enum
  regressions.
- `flake.nix`, `SECURITY.md` — accurate connector-neutral metadata and security
  inventory.
- `docs/plans/README.md` — plan index.

## Testing

- Focused: query-parameter integration tests.
- Full: `npm test`, `npm run typecheck`, `npm run build`, `npm run bundle`,
  `npm pack --dry-run --json ./dist`, `npm ls --all`, and
  `npm audit --audit-level=low`.
- Packaging: verify `dist/package.json` advertises `node >=22.13.0`.
- Nix: `nix build .#claudescope`; update `npmDepsHash` only if the dependency
  cache actually changes.
- Hygiene: Markdown lint where available and `git diff --check`.

## Risks / open questions

- Tightening the minimum Node version intentionally rejects 22.12 instead of
  requiring users to know about an experimental runtime flag.
- Invalid enum strings change from silent fallback/broadening to `400`. This is
  limited to callers already outside the documented typed API contract.
- Calendar validation must preserve accepted timestamp forms and DuckDB's
  current timezone semantics; it only rejects impossible date/time values and
  does not normalize valid input.
