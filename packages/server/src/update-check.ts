/**
 * Update-availability check against the npm registry, shared by the CLI
 * (start/status notices, the `update` command) and the daemon (which surfaces
 * `updateAvailable` on /api/health for the web UI's sidebar nudge).
 *
 * The registry lookup is cached on disk for 24h (update-check.json in the
 * state dir), so however often callers ask, the network is hit at most once a
 * day. Everything degrades to "no info" (null) offline — never throws.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION, CLAUDESCOPE_HOME } from './config.js';

export const PKG = '@vladar107/claudescope';
const UPDATE_CHECK_FILE = join(CLAUDESCOPE_HOME, 'update-check.json');
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Compare two `x.y.z` versions; true if `a` is strictly newer than `b`. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

/** Latest published version, cached for 24h. Null on any failure (offline). */
export async function getLatestVersion(force: boolean): Promise<string | null> {
  const now = Date.now();
  if (!force && existsSync(UPDATE_CHECK_FILE)) {
    try {
      const cached = JSON.parse(readFileSync(UPDATE_CHECK_FILE, 'utf8')) as {
        lastCheck: number;
        latest: string;
      };
      if (now - cached.lastCheck < UPDATE_CHECK_TTL_MS) return cached.latest;
    } catch {
      /* fall through to a fresh fetch */
    }
  }
  const url = `https://registry.npmjs.org/${PKG.replaceAll('/', '%2f')}/latest`;
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) return null;
  const json = (await res.json()) as { version?: string };
  if (!json.version) return null;
  mkdirSync(CLAUDESCOPE_HOME, { recursive: true });
  writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({ lastCheck: now, latest: json.version }));
  return json.version;
}

/** Last version seen by {@link refreshLatestVersion} (daemon-side cache). */
let cachedLatest: string | null = null;

/** The newer published version the daemon knows about, or null. */
export function updateAvailable(): string | null {
  return cachedLatest && isNewer(cachedLatest, APP_VERSION) ? cachedLatest : null;
}

/** The last latest-version value the daemon fetched, newer or not (for the
 *  Settings Update card, which also shows the "up to date" state). */
export function getCachedLatest(): string | null {
  return cachedLatest;
}

/** Refresh the daemon-side cache from the (file-cached) registry lookup.
 *  Never throws — offline just leaves the last-known value in place. */
export async function refreshLatestVersion(): Promise<void> {
  try {
    cachedLatest = (await getLatestVersion(false)) ?? cachedLatest;
  } catch {
    /* offline or registry hiccup — keep the last-known value */
  }
}
