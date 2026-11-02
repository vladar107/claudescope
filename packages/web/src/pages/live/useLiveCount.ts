import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import { LIVE_WINDOW_EVENT, readLiveWindow } from './prefs.js';

/** Poll cadence for the nav badge while the tab is visible. */
const COUNT_POLL_MS = 15_000;

/** Live session count for the nav badge; polls only while the tab is visible. */
export function useLiveCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let windowMin = readLiveWindow();

    const poll = () => {
      controller?.abort();
      controller = new AbortController();
      api
        .liveCount(windowMin, controller.signal)
        .then((res) => setCount(res.count))
        .catch(() => {
          /* the badge is best-effort; the next poll retries */
        });
    };

    const sync = () => {
      if (document.visibilityState === 'visible') {
        poll();
        if (timer === undefined) timer = window.setInterval(poll, COUNT_POLL_MS);
      } else {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    const onWindowChange = (event: Event) => {
      windowMin = (event as CustomEvent<number>).detail;
      poll();
    };

    document.addEventListener('visibilitychange', sync);
    window.addEventListener(LIVE_WINDOW_EVENT, onWindowChange);
    sync();
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener(LIVE_WINDOW_EVENT, onWindowChange);
      window.clearInterval(timer);
      controller?.abort();
    };
  }, []);

  return count;
}
