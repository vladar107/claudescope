/**
 * Server status: a lightweight /api/health poller behind a context.
 *
 * Polls fast (1s) while the index is building — first start or a post-update
 * schema rebuild — so pages can show live progress and refetch growing data,
 * then stops entirely once the server is ready and idle: steady state costs a
 * single health call per page load. Any fetch failure means "server
 * unreachable" (startup or restart window; network errors throw TypeError, not
 * ApiError) and is retried slowly until the server comes back.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { IndexingProgress } from '@claudescope/shared';
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
}

const idleStatus: ServerStatus = { ready: null, indexing: null, building: false, indexingTick: 0 };

const StatusContext = createContext<ServerStatus>(idleStatus);

/** Poll intervals: fast while the index builds, slow while unreachable. */
const BUILDING_POLL_MS = 1000;
const UNREACHABLE_POLL_MS = 5000;

export function StatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ServerStatus>(idleStatus);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const h = await api.health();
        if (cancelled) return;
        const building = !h.ready || h.indexing != null;
        setStatus((s) => ({
          ready: h.ready,
          indexing: h.indexing ?? null,
          building,
          indexingTick: building ? s.indexingTick + 1 : s.indexingTick,
        }));
        // Ready and idle: stop polling entirely.
        if (building) timer = window.setTimeout(() => void tick(), BUILDING_POLL_MS);
      } catch {
        if (cancelled) return;
        timer = window.setTimeout(() => void tick(), UNREACHABLE_POLL_MS);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  return <StatusContext.Provider value={status}>{children}</StatusContext.Provider>;
}

export function useServerStatus(): ServerStatus {
  return useContext(StatusContext);
}
