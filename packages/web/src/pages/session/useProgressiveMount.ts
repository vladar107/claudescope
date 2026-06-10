import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ThreadItem } from '@claudescope/shared';

/** Turns mounted in the first React commit — enough to fill several screens. */
export const INITIAL_TURNS = 80;
/** Turns added per idle tick / per ensureMounted overshoot. */
export const CHUNK_TURNS = 50;

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
} {
  const total = items.length;
  const [mounted, setMounted] = useState(() => Math.min(INITIAL_TURNS, total));
  const allMounted = mounted >= total;

  const indexByUuid = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, i) => map.set(item.uuid, i));
    return map;
  }, [items]);

  // Stream the remaining turns in during idle time (Safari lacks
  // requestIdleCallback — fall back to a short timeout).
  useEffect(() => {
    if (allMounted) return;
    const grow = () => setMounted((c) => Math.min(c + CHUNK_TURNS, total));
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(grow);
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(grow, 50);
    return () => window.clearTimeout(handle);
  }, [allMounted, mounted, total]);

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

  return { visibleItems, allMounted, mounted, ensureMounted };
}
