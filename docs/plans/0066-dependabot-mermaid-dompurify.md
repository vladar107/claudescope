# 0066 — Dependabot Mermaid and DOMPurify remediation

- **Status:** in-progress <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-08-09
- **PR:** <link, once opened>

## Context

Dependabot alerts #26–#31 report five vulnerabilities in `mermaid@11.16.0`
and one in its transitive `dompurify@3.4.12`. The Mermaid findings include
prototype pollution, CSS injection, and two denial-of-service paths in diagram
parsers; DOMPurify has an XSS path under a non-default in-place hook pattern.

ClaudeScope renders Mermaid fences from transcript content in the browser. Its
strict Mermaid configuration, CSP, and 50,000-character input limit reduce some
of the exposure, and the DOMPurify hook conditions are not used directly, but
the diagram source itself is untrusted. Patched releases are available without
a major-version migration: Mermaid 11.16.1 and DOMPurify 3.4.13.

A fresh `npm audit` also reports `nanoid@3.3.16` (development-only through
Vite/PostCSS) for an infinite-loop advisory. Its parent range already permits
the patched release; the targeted refresh resolves 3.3.18 (patched since
3.3.17).

## Goal

Resolve all current Dependabot alerts and audit findings with targeted patch
updates, preserving the existing Mermaid rendering behavior and avoiding
unnecessary overrides.

## Decisions

- **Raise the direct Mermaid floor to `^11.16.1`** — this records the first safe
  release in the manifest instead of relying only on a refreshed lockfile.
- **Refresh DOMPurify and Nano ID transitively** — their parent ranges already
  allow the patched releases, so direct dependencies or root overrides would
  add maintenance without constraining the graph further.
- **Keep the existing rendering boundary unchanged** — strict mode, the CSP,
  and the diagram-size limit remain useful defense in depth; the dependency
  patches do not require application-code changes.

## Approach

1. Update Mermaid to 11.16.1 and refresh DOMPurify to 3.4.13.
2. Refresh Nano ID to 3.3.18 within PostCSS's existing range.
3. Update the Nix `npmDepsHash` for the changed package-lock dependency set.
4. Verify the resolved graph, audit result, tests, typecheck, build, and bundle.
5. Review the final dependency-only diff and confirm Dependabot rescans cleanly.

## Files affected

- `packages/web/package.json` — require the first patched Mermaid release.
- `package-lock.json` — resolve patched Mermaid, DOMPurify, and Nano ID versions.
- `flake.nix` — refresh the fixed-output npm dependency hash.
- `docs/plans/0066-dependabot-mermaid-dompurify.md` — record scope and validation.
- `docs/plans/README.md` — index this plan.

## Testing

- `npm ls mermaid dompurify nanoid --all`
- `npm audit --audit-level=low`
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run bundle`
- `nix build .#claudescope --no-link` when Nix is available; otherwise refresh
  the hash from the CI mismatch and rerun the Nix job.

## Risks / open questions

- Mermaid and DOMPurify are runtime browser dependencies, but both changes are
  patch releases. The full web build and existing rendering tests should catch
  integration regressions.
- GitHub may take a short time to rescan `package-lock.json` after the PR branch
  is pushed; local `npm audit` and the resolved graph provide immediate proof.
