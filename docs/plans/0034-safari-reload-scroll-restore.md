# 0034 — Restore reader's place after a full reload (Safari ⌘R)

- **Status:** in-progress <!-- proposed | in-progress | done | superseded | abandoned -->
- **Date:** 2026-07-02
- **PR:** <link, once opened>

## Context

The session page intercepts ⌘R/Ctrl+R (`SessionPage.tsx`) to do an in-place soft
refresh instead of a full browser reload, so the reader keeps their place in the
transcript. **Safari ignores `preventDefault()` on ⌘R** — it's a protected
navigation shortcut there (unlike Chrome/Firefox) — so Safari users get a full
reload and lose their scroll position. The interception cannot be made to work
in Safari; no page is allowed to block that shortcut.

Constraints that shape the fix:

- The scroll container is not the window — it's the `<main class="tv-main">`
  pane (`overflow-y: auto`), so native browser scroll restoration doesn't apply.
- Turns mount progressively (`useProgressiveMount`, first ~80 turns): after a
  reload most of the transcript has no height yet, so a raw `scrollTop` restore
  would land wrong. Restoration must anchor to a turn and ride the existing
  `ensureMounted` retry loop the `#<uuid>` hash deep-link effect uses.
- A soft refresh swaps `data` without unmounting — restoration must never fire
  there (same guard pattern as `hashScrolledForId`).

## Goal

A full reload of a session page — Safari ⌘R, hard reloads anywhere — lands the
reader back at the same turn at the same on-screen offset. Chrome/Firefox ⌘R
soft refresh is unchanged. Expanded blocks / finder state are out of scope; only
the scroll position ("your place").

## Decisions

- **Restore the place after reload, instead of an alternate Safari shortcut** —
  user-confirmed. Works in every browser and also fixes accidental reloads; a
  new keybinding would fix nothing for muscle-memory ⌘R.
- **Anchor = topmost visible turn uuid + pixel delta, not raw scrollTop** —
  progressive mounting makes absolute offsets meaningless after reload; a uuid
  can be force-mounted via the existing `ensureMounted` machinery.
- **`sessionStorage`, key `claudescope-scroll:<sessionId>`** — per-tab (two tabs
  on one session don't clobber each other), naturally expires with the browsing
  session. All access `try/catch`-wrapped (private mode ⇒ feature no-ops),
  following the `ThemeProvider` precedent.
- **Save on throttled scroll + `pagehide` flush** — `pagehide`, not
  `beforeunload`: it fires reliably in Safari (the browser that matters here)
  and doesn't break BFCache eligibility.
- **Restore only when the document loaded on this session** (module-scope
  capture of the initial `/sessions/:id` pathname) — SPA navigation to a
  session is an intentional "open this session" and still lands at the top.
  BFCache back-nav needs nothing: DOM and scroll are restored intact.
- **`#<uuid>` deep links win over a saved place** — the hash effect owns the
  scroll; restoration bows out.
- **Uuid gone after reload → nearest turn by saved index, centered** — cheap
  and lands close; empty session → no-op.
- **Post-restore "anchor hold" (~1.2 s), not a one-shot scroll** — added after
  end-to-end verification: async syntax highlighting settles within ~500 ms of
  the restore and reflows the transcript above the anchor by hundreds of px
  (~820 px observed). Chrome's native scroll anchoring compensates, but Safari
  — the browser this feature exists for — has none. The hold re-aligns the
  anchor every frame until layout settles, and cancels itself the moment any scroll
  it didn't make happens (user wheel/touch, a hash navigation, finder jumps,
  Chrome's scroll anchoring), so it never fights the reader.
- **Read the anchor uuid from `article.id`, resolve its index via a uuid→index
  map** — some turn variants render `null`, so DOM position ≠ `items` index.

## Approach

1. New hook `packages/web/src/pages/session/useScrollRestore.ts`:
   - Save path: throttled (300 ms trailing) `scroll` listener on `.tv-main`
     (scroll doesn't bubble — attached directly) + `pagehide` flush. Topmost
     visible turn found by binary search over `:scope > article.tv-turn`
     (articles are vertically ordered). At-top ⇒ `removeItem` (reload = plain
     load). Saves skipped while the thread is hidden (Files-changed tab shares
     the scroller and must not corrupt the saved place).
   - Restore path: effect modeled on the hash deep-link effect — once per
     session id (ref guard), bails on SPA nav or a hash, `ensureMounted` +
     retry-on-`mounted`-growth until the anchor exists, then holds the anchor
     at the saved delta (exact match) or centered (index fallback) for ~1.2 s
     while late content settles. No highlight.
   - Pure helpers `parseSavedPlace` / `resolveAnchor` exported for tests.
2. Wire into `SessionView` (`SessionPage.tsx`): one hook call, passing
   `meta.id`, `items`, and the `useProgressiveMount` outputs. The ⌘R
   interception and the Refresh button/tooltip stay byte-for-byte unchanged —
   "without losing your place (⌘R)" becomes true in every browser.
3. Tests (`packages/web/test/scrollRestore.test.ts`): pure-logic only —
   malformed/wrong-shape stored JSON, uuid-gone index fallback + clamping,
   empty session. No jsdom scroll simulation; DOM behavior verified manually.

## Files affected

- `packages/web/src/pages/session/useScrollRestore.ts` — new; the hook and
  pure helpers.
- `packages/web/src/pages/session/SessionPage.tsx` — import + one hook call in
  `SessionView`.
- `packages/web/test/scrollRestore.test.ts` — new; helper edge cases.

## Testing

- `npm test`, `npm run typecheck`.
- Safari (motivating case): open a long session (>80 turns), scroll deep, ⌘R →
  full reload returns to the same turn at the same offset, no highlight; repeat
  from the very bottom (exercises the `ensureMounted` walk).
- Chrome: ⌘R still soft-refreshes in place; ⌘⇧R hard-reloads and also restores
  the place (acceptable — the escape hatch is about fresh data, not losing your
  spot).
- Hash deep link with a saved place present → hash wins. Browse → session SPA
  nav → lands at top. Scrolling the Files-changed tab then reloading leaves the
  conversation place untouched. Safari private window → feature silently inert.

## Risks / open questions

- If the session shrank server-side, the index fallback lands near, not at, the
  old place — acceptable for a rebuilt transcript.
- Layout shift that finishes after the 1.2 s hold window would still nudge the
  position; not observed locally (settle completed in ~500 ms), and the hash
  deep-link accepts the same limitation.
- Verified end-to-end in headless Chrome (exact restore byte-stable across two
  reloads; fallback, SPA-nav, hash-precedence, corrupt-storage, tab-guard, and
  Ctrl+R soft-refresh probes all pass). Real-Safari WebDriver run blocked on
  the "Allow remote automation" Safari setting — worth one manual ⌘R check.
