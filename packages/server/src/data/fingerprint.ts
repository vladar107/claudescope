/**
 * Live change token for a single session, powering the session page's
 * auto-refresh poller. Resolves the session's files from the index (same
 * source of truth as the session loader), then live-stats each one via the
 * owning connector — so growth shows up within one poll, with no reindex.
 * Read-only: never triggers a reindex and never touches the `sessions` table.
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { SessionFingerprintResponse } from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { connectorById } from '../connectors/registry.js';

/** fs.stat default for file-backed connectors; `Math.floor` matches `discover()`. */
function defaultStat(path: string): { mtimeMs: number; size: number } {
  const st = statSync(path);
  return { mtimeMs: Math.floor(st.mtimeMs), size: st.size };
}

/** One indexed file of a session, as stored in the `files` table. */
export interface SessionFileRow {
  path: string;
  connector_id?: unknown;
}

/**
 * Hash the session's per-file (path, mtime, size) plus the files-table row
 * count, so both a live append and a reindex-discovered new file (e.g. a
 * subagent transcript, recorded ≤ one reindex interval later) flip the token.
 * Deleted/unreadable files are skipped from the stat parts but still counted by
 * the row-count prefix, so newly failing files flip it too. `rows` must be
 * non-empty. Shared by the per-session probe and the Live tab's batch path.
 */
export function fingerprintFromRows(rows: SessionFileRow[]): SessionFingerprintResponse {
  // One connector per session — the same assumption the session loader makes.
  const connector = connectorById(rows[0]?.connector_id != null ? String(rows[0].connector_id) : null);

  const sorted = [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts: string[] = [];
  let lastModifiedMs = 0;
  for (const r of sorted) {
    const path = String(r.path);
    let st: { mtimeMs: number; size: number } | null = null;
    try {
      st = connector.statFile ? connector.statFile(path) : defaultStat(path);
    } catch {
      // Gone or unreadable — skip; the row-count prefix still reflects it.
    }
    if (!st) continue;
    parts.push(`${path}:${st.mtimeMs}:${st.size}`);
    if (st.mtimeMs > lastModifiedMs) lastModifiedMs = st.mtimeMs;
  }

  const fingerprint = createHash('sha1').update(`${rows.length}|${parts.join('|')}`).digest('hex');
  return { fingerprint, lastModifiedMs };
}

/** Fingerprint of one session; `null` for a session with no indexed files (→ 404). */
export async function computeSessionFingerprint(
  sessionId: string,
): Promise<SessionFingerprintResponse | null> {
  const conn = await getConnection();
  const rows = await queryRows(
    conn,
    `SELECT path, connector_id FROM files WHERE session_id = ${sqlString(sessionId)} ORDER BY path`,
  );
  if (rows.length === 0) return null;
  return fingerprintFromRows(rows as unknown as SessionFileRow[]);
}
