/**
 * Live-session auto-refresh: poll the lightweight per-session fingerprint
 * endpoint while the transcript looks actively written, and trigger the page's
 * silent soft refresh when it changes. Modeled on StatusProvider's
 * self-rescheduling loop — fast while live, slower after a transient error,
 * stopped entirely once the session goes idle (a visibility/focus re-check
 * revives it). Also home to the stick-to-bottom helpers the refresh path uses
 * so a reader tailing the session follows new turns.
 */

import { useEffect, useRef } from 'react';
import { api, ApiError } from '../../api/client.js';

/** Poll cadence while the session looks live. */
const LIVE_POLL_MS = 2000;
/** A session counts as live for this long after its last file modification. */
const LIVE_WINDOW_MS = 3 * 60_000;
/** Retry cadence after a transient fetch failure (server restart window etc.). */
const LIVE_ERROR_POLL_MS = 5000;

export function useLiveSession({
  sessionId,
  active,
  refreshSilently,
}: {
  sessionId: string | undefined;
  /** Gate: only poll once the page has data (the baseline matches what's shown). */
  active: boolean;
  /** Silent in-place data swap; resolves true when new data actually landed. */
  refreshSilently: () => Promise<boolean>;
}): void {
  // Latest-callback ref so refresh identity churn doesn't tear the loop down.
  const refreshRef = useRef(refreshSilently);
  refreshRef.current = refreshSilently;

  useEffect(() => {
    if (!sessionId || !active) return;
    let cancelled = false;
    let timer: number | undefined;
    let lastFingerprint: string | null = null; // baseline = first successful probe
    let inFlight = false;

    const schedule = (ms: number) => {
      timer = window.setTimeout(() => void tick(), ms);
    };

    const tick = async () => {
      if (cancelled || inFlight) return;
      // Hidden tab: go idle without fetching — visibility/focus re-kicks.
      if (document.hidden) return;
      inFlight = true;
      try {
        const fp = await api.sessionFingerprint(sessionId);
        if (cancelled) return;
        if (lastFingerprint === null) {
          // First probe: the page just fetched the data this baseline matches.
          lastFingerprint = fp.fingerprint;
        } else if (fp.fingerprint !== lastFingerprint) {
          // Commit the baseline only when the swap landed — a skipped/failed
          // refresh keeps the old one so the next tick retries.
          if (await refreshRef.current()) lastFingerprint = fp.fingerprint;
        }
        if (cancelled) return;
        // Keep polling only while the transcript was written to recently;
        // otherwise go idle (a visibility/focus re-check revives the loop).
        if (Date.now() - fp.lastModifiedMs <= LIVE_WINDOW_MS) schedule(LIVE_POLL_MS);
      } catch (err) {
        if (cancelled) return;
        // Unknown session: stop for good. Anything else is transient (server
        // restart window, brief network hiccup) — retry slowly.
        if (err instanceof ApiError && err.status === 404) return;
        schedule(LIVE_ERROR_POLL_MS);
      } finally {
        inFlight = false;
      }
    };

    // Returning to the tab (or window) probes once, which catches up on any
    // change made while away and revives polling if the session is live again.
    const kick = () => {
      if (cancelled || document.hidden || inFlight) return;
      window.clearTimeout(timer);
      void tick();
    };
    const onVisibility = () => {
      if (!document.hidden) kick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', kick);
    void tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', kick);
    };
  }, [sessionId, active]);
}

/** "Near bottom" slack (px) below which a refresh keeps the reader pinned. */
const STICK_BOTTOM_PX = 100;
/**
 * How long to keep re-pinning after a swap — appended turns mount over several
 * frames (progressive mounting) and Shiki highlights swap in async, so a single
 * post-commit scroll would undershoot. Same rationale as useScrollRestore's
 * HOLD_MS.
 */
const BOTTOM_HOLD_MS = 1200;

/** True when the scroller is within {@link STICK_BOTTOM_PX} of its bottom. */
export function isNearBottom(scroller: HTMLElement): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_BOTTOM_PX;
}

/**
 * Keep the scroller pinned to its (growing) bottom until layout settles. Any
 * scroll the hold didn't make itself — user wheel/touch, a hash navigation —
 * cancels it immediately (the holdAnchor pattern from useScrollRestore).
 */
export function holdBottom(scroller: HTMLElement, isCancelled: () => boolean): void {
  const start = performance.now();
  let expected: number | null = null;
  const step = () => {
    if (isCancelled()) return;
    if (expected !== null && Math.abs(scroller.scrollTop - expected) > 1) return;
    const target = scroller.scrollHeight - scroller.clientHeight;
    if (Math.abs(scroller.scrollTop - target) > 1) scroller.scrollTop = target;
    expected = scroller.scrollTop;
    if (performance.now() - start < BOTTOM_HOLD_MS) requestAnimationFrame(step);
  };
  step();
}
