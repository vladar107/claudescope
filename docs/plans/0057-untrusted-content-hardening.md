# 0057 — Untrusted-content hardening

- **Status:** done <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-29
- **PR:** https://github.com/vladar107/claudescope/pull/77

## Context

Sixth PR from the repo-wide review. Four small guards on the paths that handle
transcript content, which is untrusted: a transcript can be hand-edited, shared,
or written by an agent that hit a bug. Two are live defects, two are latent — and
the plan says which is which, because two of them would be easy to oversell.

**1. `redactText` misses Windows home paths (LIVE).** The drive-letter branch was
followed by a literal `\/`, so `C:\Users\alice\src` never matched and the username
survived into exported Markdown and MCP/CLI output — exactly the thing the redact
toggle exists to prevent. POSIX paths were fine.

**2. Search snippets corrupt themselves (LIVE).** Marking escaped the window and
then ran one regex replace *per term* over the result, so a later term could match
markup an earlier one inserted. Searching `book mark` produced:

```text
the <<mark>mark</mark>>book</<mark>mark</mark>><mark>mark</mark> is here
```

Rendered through `dangerouslySetInnerHTML`. **Not XSS** — traced it: the only `<`
and `>` introduced come from the two literal tag strings, and the replacement is a
constant so `$&`-style injection is impossible. Garbled output, not a hole.

**3. The thread assembler crashes on odd `message` shapes (LATENT).** Transcripts
are read with `JSON.parse(...) as RawEvent` and never shape-checked, so a
`user`/`assistant` row can carry no `message`, or a `content` that is neither
string nor array. The indexer's SQL *explicitly* tolerates this
(`WHEN message IS NULL THEN …`), so such rows get indexed — and then the detail
route 500'd on `Cannot read properties of undefined`, leaving a session that lists
in Browse but cannot be opened. Scanning the reviewer's real corpus found **0 of
5,687** such rows, so this is a robustness guard, not a live bug.

**4. `extractImage` trusts `media_type` (LATENT).** The base64 branch interpolated
it verbatim, so a poisoned block yielded `data:text/html;base64,…` — while the
sibling `url` branch carefully rejects non-image schemes and the *server's*
inliner has had an allowlist all along. Inert today: both callers use it only as
`<img src>`, where `text/html` simply fails to load, and the CSP allows `data:`
for images only.

## Goal

Nothing in a transcript can crash a page, corrupt rendered output, or leak a
username through the redact toggle.

## Decisions

- **Mark in one pass over the raw window instead of escaping first** — collect
  match spans, merge them, then emit escaped text with `<mark>` around the
  matched ranges. `<mark>` is never re-scanned, overlapping matches merge instead
  of nesting, and it removes the need to regex-escape user input at all (matching
  is `indexOf`-based, so there is no pattern). Rejected: marking with a
  placeholder and substituting at the end — same result, more moving parts.
- **A malformed row yields no blocks rather than a placeholder turn** — the
  assembler already skips turns that produce no blocks (that is how tool-result-only
  turns are folded away), so reusing that path needs no new concept. It also keeps
  `event.message.role` safe below without a second guard, which is now noted at
  that line because the dependency is not obvious.
- **Accept any `image/*` subtype, not a fixed list** — the invariant is "an
  `<img src>` only ever gets an image type", and enumerating formats would drop
  legitimate ones (avif, and future additions). SVG cannot execute script when
  loaded via `<img>`, so it needs no special case.
- **Do NOT tighten path matching while fixing the Windows branch** — writing the
  tests surfaced a pre-existing false positive: `/Users` is unanchored, so
  `/var/Users/notahome` collapses to `/var~`. It is also what makes a mounted home
  (`/mnt/backup/Users/alice`) redact correctly, and for a redaction helper
  over-masking is the safe direction. Documented in a test rather than changed —
  altering path semantics does not belong in a hardening PR.

## Approach

1. `routes/snippet.ts` — `matchSpans()` + single-pass emit; drop `escapeRegExp`.
2. `shared/redact.ts` — separator character class, case-insensitive drive letter.
3. `data/parser.ts` — one `messageContent()` helper for both deref sites.
4. `web/components/image.ts` — `isImageMediaType()` on the base64 branch.
5. Tests for each, extending the three existing files plus a new `redact.test.ts`.

## Files affected

- `packages/server/src/routes/snippet.ts`
- `packages/shared/src/redact.ts`
- `packages/server/src/data/parser.ts`
- `packages/web/src/components/image.ts`
- `packages/server/test/{snippet,parser}.test.ts`, `packages/web/test/image.test.ts`
- `packages/shared/test/redact.test.ts` — new (redaction had no tests at all).

## Testing

- `npm test` (559 → 583), `npm run typecheck`, `npm run build`, markdownlint.
- Each fix regression-checked by reverting it: snippet **2** failures, redact
  **3**, parser **6**, image **1**.
- The snippet tests pin the merge behaviour, casing preservation, escaping inside
  a match, and that regex metacharacters in a term are now literal.
- The parser tests assert the surrounding good turns survive one malformed row,
  and that tool_use/tool_result pairing still works across one.

## Risks / open questions

- Snippet output changes shape for overlapping matches (one merged `<mark>`
  instead of nested tags). Strictly better rendering; no caller parses it.
- `redactText` remains deliberately conservative on secrets — prefix-anchored
  patterns only. The new tests pin what it *claims* to cover rather than implying
  completeness.
- The unanchored `/Users` false positive is now documented, not fixed. If it ever
  matters, the fix is a boundary assertion — but it would make mounted-home paths
  leak instead.
