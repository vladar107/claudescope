# 0033 — Symlink-safe image resolution

- **Status:** done
- **Date:** 2026-07-02
- **PR:** https://github.com/vladar107/claudescope/pull/44

## Context

A Codex security scan of the repo (2026-07-02, rev 5306b37) validated two
medium-severity findings with runtime PoCs through the real Fastify routes:
the Copilot saved-attachment resolver (`connectors/copilot/normalize.ts`) and
the Antigravity uploaded-media resolver (`connectors/antigravity/normalize.ts`)
contain paths with `basename()` only, but `statSync`/`readFileSync` follow
symlinks — a symlink planted inside a session/conversation dir exfiltrates
arbitrary readable local files into the session-detail API response as base64.

For the localhost single-user threat model the marginal risk is low (an
attacker who can write to `~/.copilot`/`~/.gemini` already has the user's
account), but the primitive is real, the fix is small, and the Junie connector
already implements the correct realpath-containment pattern — this is an
inconsistency, not a new policy. The scan's third, deferred item (large-input
DoS) is dismissed per the threat model: single-user localhost.

## Goal

No image resolver in any connector follows a symlink outside its trusted root.
One shared helper owns the containment logic; Junie/Copilot/Antigravity all use
it.

## Decisions

- **Shared helper `connectors/safe-image.ts`** (sibling of `tool-names.ts`) —
  the three per-connector resolvers duplicate the mime map and size cap and
  disagree on containment; one implementation combines all three properties
  (ext/mime gate, realpath containment, 20 MB cap). Rejected: patching each
  resolver in place (leaves the next connector to re-introduce the bug).
- **Realpath containment, not symlink rejection** — resolve the real path of
  root and candidate and require the candidate to stay inside the root
  (Junie's `real === root || real.startsWith(root + sep)` idiom). A symlink
  that stays inside the root is harmless; rejecting all symlinks would be
  stricter than needed and diverge from the existing Junie behavior.
- **Copilot migrates in the subagent-embedding PR** — its normalize.ts is
  heavily edited there; migrating it here would entangle the two PRs.
  Antigravity and Junie migrate here.

## Approach

1. Add `packages/server/src/connectors/safe-image.ts`: shared `IMAGE_MIME`,
   `MAX_IMAGE_BYTES`, and a resolver that realpath-contains a candidate path
   inside a trusted root before reading.
2. Migrate `junie/normalize.ts` `imageBlockFromPath` (gains the size cap) and
   `antigravity/normalize.ts` `resolveImage` (gains containment).
3. Symlink fixture tests: an uploaded-media / attachment name that is a symlink
   pointing outside the trusted dir must produce no image block; in-root
   regular files (and in-root symlinks) still resolve.

## Files affected

- `packages/server/src/connectors/safe-image.ts` — new shared resolver.
- `packages/server/src/connectors/junie/normalize.ts` — use the helper.
- `packages/server/src/connectors/antigravity/normalize.ts` — use the helper.
- `packages/server/test/antigravity.integration.test.ts` — symlink fixture.
- `packages/server/test/safe-image.test.ts` / junie test — containment cases.

## Testing

`npm test` and `npm run typecheck`. New tests assert: symlink escaping the
root → no image block; regular in-root file → image block (existing happy-path
tests stay green).

## Risks / open questions

- Behavior change: Junie attachments larger than 20 MB no longer render
  (previously uncapped) — acceptable, matches the other connectors.
- Sharing untrusted transcript bundles remains out of scope; this closes the
  read primitive if it ever happens.
