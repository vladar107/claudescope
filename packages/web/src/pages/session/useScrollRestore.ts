import { useEffect, useRef, type RefObject } from 'react';
import type { ThreadItem } from '@claudescope/shared';

/**
 * Persist and restore the reader's place across full page reloads.
 *
 * The ⌘R interception in SessionPage keeps a refresh in-place on Chrome and
 * Firefox, but Safari treats ⌘R as a protected navigation shortcut and ignores
 * preventDefault — the page fully reloads. This hook makes that reload (and any
 * other hard reload) non-destructive: it continuously saves the topmost visible
 * turn + its pixel offset to sessionStorage, and on a fresh document load of
 * the same session scrolls back to it once the turn is mounted.
 *
 * A raw scrollTop is useless here: turns mount progressively (see
 * useProgressiveMount), so after a reload most of the transcript has no height
 * yet. Anchoring to a turn uuid lets the restore ride the existing
 * `ensureMounted` retry loop the hash deep-link effect uses.
 */

/** sessionStorage key prefix — per-session, per-tab. */
const STORAGE_PREFIX = 'claudescope-scroll:';
const SAVE_THROTTLE_MS = 300;

interface SavedPlace {
  /** Topmost visible turn's uuid (= its article element id). */
  uuid: string;
  /** Its index in `items` at save time — fallback if the uuid disappears. */
  index: number;
  /** anchor top − scroller top at save time (px), so restore is exact. */
  delta: number;
}

/** Parse + validate a stored place; null for anything malformed. */
export function parseSavedPlace(raw: string | null): SavedPlace | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const { uuid, index, delta } = v as Record<string, unknown>;
    if (typeof uuid !== 'string' || uuid === '') return null;
    if (typeof index !== 'number' || !Number.isFinite(index) || index < 0) return null;
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return null;
    return { uuid, index, delta };
  } catch {
    return null;
  }
}

/**
 * Resolve the saved place against the current turn list: the exact uuid when
 * it still exists (scroll restores to the exact offset), otherwise the nearest
 * turn by saved index (restore centers it instead — `exact: false`).
 */
export function resolveAnchor(
  saved: SavedPlace,
  indexByUuid: Map<string, number>,
  items: readonly { uuid: string }[],
): { uuid: string; exact: boolean } | null {
  if (indexByUuid.has(saved.uuid)) return { uuid: saved.uuid, exact: true };
  const nearest = items[Math.min(saved.index, items.length - 1)];
  return nearest ? { uuid: nearest.uuid, exact: false } : null;
}

/**
 * Topmost visible turn: first `article.tv-turn` child whose bottom edge is
 * below the scroller's top. Articles are vertically ordered, so binary search
 * keeps a save cheap even in a several-thousand-turn session.
 */
function pickAnchor(
  thread: HTMLElement,
  scrollerTop: number,
): { el: HTMLElement; delta: number } | null {
  const articles = thread.querySelectorAll<HTMLElement>(':scope > article.tv-turn');
  if (articles.length === 0) return null;
  let lo = 0;
  let hi = articles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (articles[mid]!.getBoundingClientRect().bottom > scrollerTop) hi = mid;
    else lo = mid + 1;
  }
  const el = articles[lo]!;
  const rect = el.getBoundingClientRect();
  if (rect.bottom <= scrollerTop) return null; // everything is above the viewport
  return { el, delta: rect.top - scrollerTop };
}

/**
 * How long to hold the restored anchor in place. Late-arriving content (async
 * syntax highlighting swapping in above the anchor) reflows the transcript by
 * hundreds of px within ~500 ms of the restore scroll. Chrome's scroll
 * anchoring compensates; Safari — the browser this feature exists for — has
 * none, so the anchor is re-aligned every frame for a beat instead.
 */
const HOLD_MS = 1200;

/**
 * Keep `el` at `targetDelta()` px below the scroller top until layout settles.
 * Any scroll the hold didn't make itself — user wheel/touch, a hash
 * navigation, finder jumps, Chrome's own scroll anchoring — cancels it
 * immediately, so it only ever counteracts silent layout shift. Also the way
 * to *navigate* to an element in this transcript: turns are sized lazily
 * (`content-visibility`), so a one-shot smooth scroll aims at a position that
 * moves by tens of thousands of pixels while the animation runs.
 */
export function holdAnchor(
  scroller: HTMLElement,
  el: HTMLElement,
  targetDelta: () => number,
  isCancelled: () => boolean,
): void {
  const start = performance.now();
  let expected: number | null = null;
  const step = () => {
    if (isCancelled() || !el.isConnected) return;
    if (expected !== null && Math.abs(scroller.scrollTop - expected) > 1) return;
    const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const diff = offset - targetDelta();
    if (Math.abs(diff) > 1) scroller.scrollTop += diff;
    expected = scroller.scrollTop;
    if (performance.now() - start < HOLD_MS) requestAnimationFrame(step);
  };
  step();
}

/**
 * The session id the document itself was loaded on. Restoration only fires
 * when the current session matches — SPA navigation to a session is an
 * intentional "open this session" and lands at the top as before. Captured
 * once at module load, before the router can rewrite the URL.
 */
const initialLoadSessionId: string | null = (() => {
  if (typeof window === 'undefined') return null; // node (tests import the helpers)
  const id = /^\/sessions\/([^/]+)/.exec(window.location.pathname)?.[1];
  if (!id) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
})();

export function useScrollRestore({
  sessionId,
  items,
  mounted,
  allMounted,
  ensureMounted,
  threadRef,
}: {
  sessionId: string;
  items: ThreadItem[];
  mounted: number;
  allMounted: boolean;
  ensureMounted: (uuid: string) => void;
  threadRef: RefObject<HTMLDivElement | null>;
}): void {
  const indexByUuid = useRef(new Map<string, number>());
  indexByUuid.current = new Map(items.map((it, i) => [it.uuid, i]));

  // ── Save: throttled on scroll, flushed on pagehide ────────────────────────
  // `pagehide` (not `beforeunload`) is what catches Safari's uninterceptable
  // ⌘R — it fires reliably there and doesn't break BFCache eligibility.
  useEffect(() => {
    const key = STORAGE_PREFIX + sessionId;
    const scroller = threadRef.current?.closest('main.tv-main');
    if (!(scroller instanceof HTMLElement)) return;

    const save = () => {
      const thread = threadRef.current;
      // Hidden thread (Files-changed tab shares the same scroller): its
      // scrolling must not clobber the conversation's saved place.
      if (!thread || thread.getClientRects().length === 0) return;
      try {
        if (scroller.scrollTop <= 4) {
          // Effectively at the top — a reload should just be a plain load.
          sessionStorage.removeItem(key);
          return;
        }
        const anchor = pickAnchor(thread, scroller.getBoundingClientRect().top);
        if (!anchor) return;
        const index = indexByUuid.current.get(anchor.el.id);
        if (index === undefined) return;
        const place: SavedPlace = { uuid: anchor.el.id, index, delta: anchor.delta };
        sessionStorage.setItem(key, JSON.stringify(place));
      } catch {
        /* sessionStorage may be unavailable (private mode) — feature no-ops */
      }
    };

    let timer: number | null = null;
    const onScroll = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        save();
      }, SAVE_THROTTLE_MS);
    };
    const flush = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      save();
    };

    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', flush);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', flush);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [sessionId, threadRef]);

  // ── Restore: once per fresh document load of this session ────────────────
  // Modeled on the hash deep-link effect: re-runs as `mounted` grows until the
  // anchor's turn exists, then scrolls. The ref guard keeps a soft refresh
  // (which swaps `items` without unmounting) from ever re-scrolling.
  const restoredForId = useRef<string | null>(null);
  const holdCancelled = useRef(false);
  // Leaving the session (or unmounting) must stop an in-flight anchor hold —
  // the `.tv-main` scroller outlives this page and must not keep being pinned.
  useEffect(() => {
    holdCancelled.current = false;
    return () => {
      holdCancelled.current = true;
    };
  }, [sessionId]);
  useEffect(() => {
    if (restoredForId.current === sessionId) return;
    if (sessionId !== initialLoadSessionId || window.location.hash) {
      // SPA navigation, or a `#<uuid>` deep-link that owns the scroll.
      restoredForId.current = sessionId;
      return;
    }
    let saved: SavedPlace | null = null;
    try {
      saved = parseSavedPlace(sessionStorage.getItem(STORAGE_PREFIX + sessionId));
    } catch {
      /* storage unavailable */
    }
    if (!saved) {
      restoredForId.current = sessionId;
      return;
    }
    const place = saved;
    const anchor = resolveAnchor(place, indexByUuid.current, items);
    if (!anchor) {
      restoredForId.current = sessionId;
      return;
    }
    const el = document.getElementById(anchor.uuid);
    if (!el) {
      if (allMounted) restoredForId.current = sessionId; // never going to appear
      else ensureMounted(anchor.uuid); // retry as turns mount
      return;
    }
    restoredForId.current = sessionId;
    const scroller = el.closest('main.tv-main');
    if (!(scroller instanceof HTMLElement)) return;
    const targetDelta = anchor.exact
      ? () => place.delta
      : // Nearest-turn fallback (the exact turn disappeared): center it, but
        // keep the top of a taller-than-viewport turn in view.
        () => Math.max(24, (scroller.clientHeight - el.getBoundingClientRect().height) / 2);
    holdAnchor(scroller, el, targetDelta, () => holdCancelled.current);
  }, [sessionId, items, mounted, allMounted, ensureMounted]);
}
