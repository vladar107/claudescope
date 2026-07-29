# 0062 — Codex title and metadata rendering

- **Status:** done
- **Date:** 2026-07-29
- **PR:** https://github.com/vladar107/claudescope/pull/83

## Context

Recent Codex rollouts can begin with a user-role bootstrap containing the
project's `AGENTS.md` instructions and an `<environment_context>` envelope.
ClaudeScope correctly preserves that source in the transcript, but Codex has no
stored session title, so the generic first-user-message fallback can derive the
title from the injected bootstrap instead of the person's first prompt.
The same bootstrap currently renders as ordinary Markdown, producing a large
wall of XML-like instructions and environment metadata above the real prompt.

Codex assistant text can also end with a reserved `<oai-mem-citation>` envelope.
Because raw HTML is intentionally disabled in the Markdown renderer, the
envelope is currently shown as ordinary prose. It is metadata, but it remains
part of the original transcript and should still be inspectable in Source mode.

## Goal

Derive untitled Codex session names from the first genuine user prompt while
preserving the injected startup context in the session behind a compact,
collapsed disclosure. Hide well-formed Codex memory-citation metadata from
rendered assistant Markdown without changing the stored/source transcript.

## Decisions

- **Preserve Codex bootstrap turns** — do not drop or rewrite the AGENTS and
  environment context during normalization; it remains useful provenance in the
  transcript.
- **Fix title selection at the title boundary** — when a Codex fallback
  candidate is exactly the known bootstrap envelope, skip it; when Codex has
  coalesced the bootstrap and real prompt into one user event, strip only the
  leading well-formed envelope before applying the existing title cleaner.
- **Fail closed on unfamiliar shapes** — malformed or unrecognized text is left
  untouched instead of broadly classifying arbitrary user prose as system input.
- **Collapse, do not discard, startup context** — recognize complete Codex
  AGENTS/instructions and environment blocks at the presentation boundary and
  render their exact text in collapsed system-style disclosures. If a real
  prompt shares the same text block, render the remainder normally.
- **Rendered derivative only for memory citations** — remove a well-formed,
  trailing `<oai-mem-citation>…</oai-mem-citation>` block only from assistant
  Markdown passed to the renderer. Keep `block.text` as the exact Source-mode
  value and do not alter indexing, export, or connector normalization.
- **Rebuild the derived index** — bump the schema version because existing
  persisted fallback titles must be recalculated after upgrading.

## Approach

1. Update fallback-title selection to identify Codex sessions and remove only a
   leading, well-formed AGENTS/instructions/environment bootstrap before ranking
   candidates. This skips a bootstrap-only row and retains the prompt from a
   coalesced bootstrap-plus-prompt row before the existing Markdown/title cleanup.
2. Bump the index schema version so installed databases rebuild and replace
   already-derived bootstrap titles.
3. Recognize complete Codex instructions/environment prefixes in session text
   blocks and render them as collapsed context, leaving any trailing prompt as
   normal user Markdown.
4. Add a session-rendering text helper for trailing Codex memory-citation
   envelopes and apply it only to assistant text's rendered value, passing the
   original text through the existing `source` prop.
5. Run the existing test suite, typecheck, and production build; verify the two
   supplied transcript shapes with focused local checks; then review the diff.

## Files affected

- `packages/server/src/data/index.ts` — connector-aware fallback-title candidate
  selection.
- `packages/server/src/db/schema.ts` — derived-data schema version bump.
- `packages/web/src/pages/session/text.ts` — startup-context recognition and
  rendered-only memory-citation cleanup.
- `packages/web/src/pages/session/blocks.tsx` — collapse preserved startup
  context and render cleaned assistant Markdown while retaining exact source.
- `packages/web/src/pages/session/ThreadView.tsx` — pass the turn role to the
  block renderer so user-authored examples are not hidden.
- `docs/plans/README.md` — plan index entry.

## Testing

- Run `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.
- Use focused local checks for both Codex storage shapes: a bootstrap-only first
  user event followed by a prompt, and a coalesced bootstrap-plus-prompt event.
- Confirm rendered assistant prose omits a trailing memory-citation envelope,
  while Source mode still shows the exact original block.
- Confirm complete AGENTS and environment blocks are collapsed but recoverable,
  and a coalesced real prompt remains visible outside the disclosure.
- Per repository instruction, do not add new test files or cases unless the
  maintainer explicitly requests them.

## Risks / open questions

- The title recognizer intentionally depends on Codex's reserved wrapper shape;
  a future incompatible wrapper will remain visible and may require a small
  follow-up rather than risking false positives on genuine prompts.
- Memory-citation metadata remains searchable/exportable because this change is
  presentation-only. That preserves transcript fidelity; filtering those other
  surfaces would be a separate product decision.
