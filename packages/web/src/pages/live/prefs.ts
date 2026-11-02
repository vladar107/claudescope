import { LIVE_DEFAULT_WINDOW_MINUTES, LIVE_WINDOW_MINUTES } from '@claudescope/shared';

export const LIVE_WINDOW_KEY = 'claudescope.live.windowMin';
export const LIVE_STALL_KEY = 'claudescope.live.stallMin';
/** Dispatched on `window` with the new window (minutes) as `detail` whenever it is written. */
export const LIVE_WINDOW_EVENT = 'claudescope:live-window';
export const LIVE_STALL_MINUTES = [1, 3, 10] as const;
export const LIVE_DEFAULT_STALL_MINUTES = 3;

function readStored(key: string, allowed: readonly number[], fallback: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable: the choice simply does not persist */
  }
}

export function readLiveWindow(): number {
  return readStored(LIVE_WINDOW_KEY, LIVE_WINDOW_MINUTES, LIVE_DEFAULT_WINDOW_MINUTES);
}

export function writeLiveWindow(value: number): void {
  writeStored(LIVE_WINDOW_KEY, value);
  window.dispatchEvent(new CustomEvent<number>(LIVE_WINDOW_EVENT, { detail: value }));
}

export function readLiveStall(): number {
  return readStored(LIVE_STALL_KEY, LIVE_STALL_MINUTES, LIVE_DEFAULT_STALL_MINUTES);
}
