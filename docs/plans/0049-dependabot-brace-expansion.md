# 0049 — Dependabot #6: brace-expansion DoS remediation

- **Status:** done
- **Date:** 2026-07-22
- **PR:** https://github.com/vladar107/claudescope/pull/67

## Context

Dependabot alert #6 reports CVE-2026-13149 / GHSA-3jxr-9vmj-r5cp: an
exponential-time denial of service in `brace-expansion`. The lockfile resolves
the vulnerable `5.0.6` transitively through `@fastify/static` → `glob` →
`minimatch`.

## Goal

Resolve `brace-expansion` to the minimal patched release, `5.0.7`, without
changing direct dependency ranges or application code.

## Decisions

- **Do not add a direct dependency or override** — the vulnerable package is
  transitive; its parent range (`^5.0.5`) already permits `5.0.7`.
- **Refresh the Nix dependency hash** — `fetchNpmDeps` hashes the lockfile's
  dependency set, so the patched tarball requires the corresponding hash update.

## Approach

1. Regenerate the lockfile's `brace-expansion` resolution at `5.0.7`.
2. Update the flake's `fetchNpmDeps` hash to match the patched lockfile.
3. Confirm the installed tree has no vulnerable `brace-expansion` release.
4. Run the repository tests, TypeScript check, and Nix build; then review the diff.

## Files affected

- `package-lock.json` — resolve the patched transitive dependency.
- `flake.nix` — refresh the fixed-output hash for the changed dependency set.

## Testing

Run `npm ls brace-expansion`, `npm test`, `npm run typecheck`, and
`nix build .#claudescope --no-link`.

## Risks / open questions

The patch version is within the existing semver range. No behavior change is
expected beyond the advisory's denial-of-service fix.
