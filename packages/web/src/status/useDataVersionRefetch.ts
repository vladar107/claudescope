import { useEffect, useRef } from 'react';
import { useServerStatus } from './StatusProvider.js';

/**
 * Steady-state freshness: run `refetch` whenever the server's dataVersion
 * moves past the version we last fetched at — a reindex pass landed new data
 * while the page is open. The callback should refetch silently (no spinner,
 * keep scroll) and respect the abort signal.
 *
 * Semantics:
 * - The first observed version is recorded, not fetched — the mount fetch
 *   covered it.
 * - While `building`, versions are NOT recorded or fetched (the fast-poll
 *   build paths own that window); the first idle observation after a build
 *   then differs from the recorded value and triggers one catch-up refetch.
 */
export function useDataVersionRefetch(refetch: (signal: AbortSignal) => void): void {
  const { building, dataVersion } = useServerStatus();
  const lastFetched = useRef<number | null>(null);

  useEffect(() => {
    if (dataVersion === null) return;
    if (lastFetched.current === null) {
      lastFetched.current = dataVersion;
      return;
    }
    if (building || lastFetched.current === dataVersion) return;
    lastFetched.current = dataVersion;
    const controller = new AbortController();
    refetch(controller.signal);
    return () => controller.abort();
    // `refetch` is deliberately omitted: effects always run the latest render's
    // closure, and callers pass inline lambdas that change identity per render.
  }, [dataVersion, building]);
}
