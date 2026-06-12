import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ThreadItem } from '@claudescope/shared';

/** Turns mounted in the first React commit — enough to fill several screens. */
export const INITIAL_TURNS = 80;
/** Turns added per idle tick / per ensureMounted overshoot. */
export const CHUNK_TURNS = 50;

/**
 * Distance from the mounting frontier, in viewport heights, at which growth
 * switches from idle-time fill to frame-paced catch-up so a scrolling reader
 * never reaches unmounted territory.
 */
const NEAR_FRONTIER_VIEWPORTS = 1.5;

/**
 * Pure mount-count math: the count needed so the turn at `index` is mounted,
 * overshooting by a chunk so nearby navigation doesn't immediately re-grow.
 */
export function mountCountFor(index: number, current: number, total: number): number {
  if (index < current) return current;
  return Math.min(index + CHUNK_TURNS, total);
}

/**
 * Mount a huge turn list progressively: the first {@link INITIAL_TURNS} render
 * immediately (one cheap commit instead of a multi-second one for thousands of
 * turns), and the rest stream in during browser idle time. `ensureMounted`
 * synchronously extends the window for deep links and finder navigation.
 *
 * Idle time alone isn't enough: requestIdleCallback starves while the main
 * thread is busy scrolling — exactly when mounting must keep up, or the reader
 * watches chunks pop in. Attach {@link sentinelRef} to the trailing
 * "rendering more turns" element; when it nears the viewport, growth switches
 * to one chunk per animation frame until the frontier is pushed back out.
 *
 * The count is monotonic — a soft refresh that appends turns never unmounts
 * what's already on screen (turns are keyed by uuid).
 */
export function useProgressiveMount(items: ThreadItem[]): {
  visibleItems: ThreadItem[];
  allMounted: boolean;
  /** Number of currently mounted turns — effects that wait for a turn's DOM to appear should depend on it. */
  mounted: number;
  /** Make the turn with this uuid mountable now (unknown uuids grow by a chunk per call). */
  ensureMounted: (uuid: string) => void;
  /** Attach to the element that marks the mounting frontier (the "rendering more turns" note). */
  sentinelRef: (el: HTMLElement | null) => void;
} {
  const total = items.length;
  const [mounted, setMounted] = useState(() => Math.min(INITIAL_TURNS, total));
  const allMounted = mounted >= total;
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);

  const indexByUuid = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, i) => map.set(item.uuid, i));
    return map;
  }, [items]);

  const grow = useCallback(
    () => setMounted((c) => Math.min(c + CHUNK_TURNS, total)),
    [total],
  );

  // Wake the growth loop the moment the reader scrolls near the frontier (the
  // effect below then keeps it frame-paced while they stay close).
  useEffect(() => {
    if (allMounted || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) grow();
      },
      { rootMargin: `${Math.round(NEAR_FRONTIER_VIEWPORTS * 100)}% 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [allMounted, sentinel, grow]);

  // Stream the remaining turns in: frame-paced near the frontier, during idle
  // time when far from it (with a timeout so a busy main thread can't stall
  // the fill; Safari lacks requestIdleCallback — fall back to a short timeout).
  useEffect(() => {
    if (allMounted) return;
    const nearFrontier =
      sentinel !== null &&
      sentinel.getBoundingClientRect().top <
        window.innerHeight * (1 + NEAR_FRONTIER_VIEWPORTS);
    if (nearFrontier) {
      const handle = window.requestAnimationFrame(grow);
      return () => window.cancelAnimationFrame(handle);
    }
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(grow, { timeout: 500 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(grow, 50);
    return () => window.clearTimeout(handle);
  }, [allMounted, mounted, sentinel, grow]);

  const ensureMounted = useCallback(
    (uuid: string) => {
      const index = indexByUuid.get(uuid);
      // Unknown uuid (e.g. a turn inside a subagent thread, or a stale anchor):
      // grow by a chunk rather than mounting everything at once — callers retry
      // on `mounted` growth, so this walks to allMounted without reintroducing
      // the one-giant-commit freeze.
      setMounted((c) =>
        index === undefined ? Math.min(c + CHUNK_TURNS, total) : mountCountFor(index, c, total),
      );
    },
    [indexByUuid, total],
  );

  const visibleItems = useMemo(
    () => (allMounted ? items : items.slice(0, mounted)),
    [items, mounted, allMounted],
  );

  return { visibleItems, allMounted, mounted, ensureMounted, sentinelRef: setSentinel };
}
