# 0061 — Markdown source view and Mermaid rendering

- **Status:** done
- **Date:** 2026-07-29
- **PR:** https://github.com/vladar107/claudescope/pull/81

## Context

Claudescope already renders transcript prose as GFM Markdown with Shiki-backed
code fences, but readers cannot inspect the original Markdown in place and
`mermaid` fences remain ordinary code. Rendering preferences are presentation
state, so they should follow the existing browser-local theme model rather than
expand the server settings contract.

## Goal

Let readers choose rendered or source Markdown globally and per transcript
block, and render Mermaid fences locally without sending transcript content to
an external service.

## Decisions

- **Browser-local preferences** — persist Markdown and Mermaid toggles in
  `localStorage`; no server API or `settings.json` changes are needed.
- **Temporary per-block override** — a block's Rendered/Source choice lasts
  until navigation, while the Settings choice remains the default.
- **Lazy, strict Mermaid rendering** — load Mermaid only for encountered
  diagrams, use `securityLevel: "strict"`, and rely on the existing CSP as a
  second network/script boundary.
- **Source fallback** — invalid, oversized, or failed diagrams remain readable
  as source and cannot fail the surrounding transcript block.
- **PlantUML deferred** — keep the renderer boundary extensible, but do not add
  PlantUML in this iteration.

## Approach

1. Add a rendering-preferences provider with resilient browser persistence and
   immediate Settings controls.
2. Add an opt-in Rendered/Source switch to semantic transcript Markdown,
   including forced source while an in-session search match is active.
3. Route `mermaid` fences to a lazy, theme-aware diagram renderer with size and
   error fallbacks; leave all other fences on the existing Shiki path.
4. Verify typechecking, tests, production build, and the security/performance
   fallbacks, then review the complete diff.

## Files affected

- `packages/web/src/rendering/` — rendering preference context and persistence.
- `packages/web/src/components/` — Markdown mode switch and Mermaid renderer.
- `packages/web/src/pages/settings/` — browser-local rendering controls.
- `packages/web/src/pages/session/` — opt transcript blocks into the local
  switch and search-driven source reveal.
- `packages/web/package.json` / `package-lock.json` — Mermaid dependency.

## Testing

- Run `npm run typecheck`, `npm test`, and `npm run build`.
- Manually cover persisted defaults, per-block overrides, light/dark Mermaid,
  disabled/invalid/oversized Mermaid source fallbacks, finder-driven source
  reveal, and unchanged tool-output/memory behavior.

## Risks / open questions

- Mermaid is a sizeable dependency, so it must stay in a lazy chunk.
- Mermaid keeps process-global configuration; rendering must reinitialize it
  for the active theme without allowing stale asynchronous results to win.
