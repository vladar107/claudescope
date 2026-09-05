/**
 * Server status: a lightweight /api/health poller behind a context.
 *
 * Polls fast (1s) while the index is building — first start or a post-update
 * schema rebuild — so pages can show live progress and refetch growing data,
 * then drops to a slow idle poll (10s) once the server is ready. The idle poll
 * watches `dataVersion`: an incremental reindex pass is transient (sub-second),
 * so it's the only signal an idle client can observe that new data landed —
 * list pages refetch when it changes. It also keeps the update nudge live in
 * long-lived tabs. Any fetch failure means "server unreachable" (startup or
 * restart window; network errors throw TypeError, not ApiError) and is retried
 * slowly until the server comes back.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { HealthResponse, IndexingProgress } from '@claudescope/shared';
import { api } from '../api/client.js';

export interface ServerStatus {
  /** null until the first successful health response (server unreachable). */
  ready: boolean | null;
  /** Live per-pass progress, when the server reports one. */
  indexing: IndexingProgress | null;
  /** True while the index is building: not ready yet, or a pass is running. */
  building: boolean;
  /** Increments on every poll observed while building — key refetches off it. */
  indexingTick: number;
  /**
   * The server's data-change counter (null until the first health response).
   * Changes whenever a reindex pass landed new data — list pages key silent
   * refetches off it. Compare by inequality: it resets on daemon restart.
   */
  dataVersion: number | null;
  /** Newer published version the daemon reported, for the sidebar nudge. */
  updateAvailable: string | null;
  /** Compact indexer lifecycle state (null until the first health response). */
  indexer: HealthResponse['indexer'] | null;
  /** Running app version (null until the first health response). */
  version: string | null;
}

const idleStatus: ServerStatus = {
  ready: null,
  indexing: null,
  building: false,
  indexingTick: 0,
  dataVersion: null,
  updateAvailable: null,
  indexer: null,
  version: null,
};

const StatusContext = createContext<ServerStatus>(idleStatus);

/** Poll intervals: fast while the index builds, slow when idle or unreachable. */
const BUILDING_POLL_MS = 1000;
const UNREACHABLE_POLL_MS = 5000;
const IDLE_POLL_MS = 10_000;

export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ServerStatus>(idleStatus);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      // Hidden tab: go idle without fetching — visibilitychange re-kicks below.
      if (document.hidden) return;
      try {
        const h = await api.health();
        if (cancelled) return;
        const building = !h.ready || h.indexing != null;
        setStatus((s) => ({
          ready: h.ready,
          indexing: h.indexing ?? null,
          building,
          indexingTick: building ? s.indexingTick + 1 : s.indexingTick,
          dataVersion: h.dataVersion,
          updateAvailable: h.updateAvailable ?? null,
          indexer: h.indexer ?? null,
          version: h.version,
        }));
        timer = window.setTimeout(() => void tick(), building ? BUILDING_POLL_MS : IDLE_POLL_MS);
      } catch {
        if (cancelled) return;
        timer = window.setTimeout(() => void tick(), UNREACHABLE_POLL_MS);
      }
    };

    // Returning to the tab probes once, catching up on anything missed while
    // hidden and reviving the poll loop.
    const onVisibility = () => {
      if (!document.hidden) {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <StatusContext.Provider value={status}>{children}</StatusContext.Provider>;
}

export function useServerStatus(): ServerStatus {
  return useContext(StatusContext);
}
