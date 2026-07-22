# 0035 — Dependabot #6: brace-expansion DoS remediation

- **Status:** done
- **Date:** 2026-07-22
- **PR:** —

## Context

Dependabot alert #6 reports CVE-2026-13149 / GHSA-3jxr-9vmj-r5cp: an
exponential-time denial of service in `brace-expansion`. The lockfile resolves
the vulnerable `5.0.6` transitively through `@fastify/static` → `glob` →
`minimatch`.

## Goal

Resolve `brace-expansion` to the minimal patched release, `5.0.7`, without
changing direct dependency ranges or application code.

## Decisions

- **Update only `package-lock.json`** — the vulnerable package is transitive;
  its parent range (`^5.0.5`) already permits `5.0.7`, so a direct override or
  unrelated dependency upgrade is unnecessary.

## Approach

1. Regenerate the lockfile's `brace-expansion` resolution at `5.0.7`.
2. Confirm the installed tree has no vulnerable `brace-expansion` release.
3. Run the repository test suite and TypeScript check, then review the diff.

## Files affected

- `package-lock.json` — resolve the patched transitive dependency.

## Testing

Run `npm ls brace-expansion`, `npm test`, and `npm run typecheck`.

## Risks / open questions

The patch version is within the existing semver range. No behavior change is
expected beyond the advisory's denial-of-service fix.
