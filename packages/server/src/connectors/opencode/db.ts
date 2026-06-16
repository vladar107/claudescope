/**
 * Read-only opencode SQLite access via Node's built-in `node:sqlite` (Node 24 —
 * no new dependency). opencode keeps all transcripts in one DB
 * (`session`/`message`/`part`), so the connector reads it here and the normalizer
 * turns a session into canonical rows / events.
 *
 * STRICTLY READ-ONLY: every open is `{readOnly:true}` and the handle is closed
 * immediately; the app NEVER writes the DB or touches `-wal`/`-shm`.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

/** One session's change signal, for incremental discovery. */
export interface OpencodeSessionMeta {
  id: string;
  /** max(session, message, part).time_updated — `session.time_updated` lags the last turn. */
  mtimeMs: number;
  /** Monotonic-on-change size proxy: message + part counts. */
  size: number;
}

/** One session's raw rows (JSON `data` left as strings for the normalizer to parse). */
export interface OpencodeRawSession {
  id: string;
  directory: string;
  title: string;
  /** message rows in creation order. */
  messages: { id: string; data: string }[];
  /** part `data` strings grouped by message id, each list in creation order. */
  partsByMessage: Map<string, string[]>;
}

function open(dbPath: string): InstanceType<typeof DatabaseSync> {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * Enumerate every session with its change signal.
 *
 * Returns `[]` when the DB FILE is absent (opencode not installed). When the file
 * EXISTS but can't be opened/queried, it THROWS — the indexer's prune loop is not
 * connector-scoped, so a silent `[]` on a transient SQLite error would make it
 * treat every opencode session as deleted and wipe them all (see plan 0020).
 */
export function listSessions(dbPath: string): OpencodeSessionMeta[] {
  if (!existsSync(dbPath)) return [];
  const db = open(dbPath);
  try {
    const rows = db
      .prepare(
        `SELECT s.id AS id,
           max(
             s.time_updated,
             COALESCE((SELECT max(time_updated) FROM message m WHERE m.session_id = s.id), 0),
             COALESCE((SELECT max(time_updated) FROM part    p WHERE p.session_id = s.id), 0)
           ) AS mtime,
           (
             (SELECT count(*) FROM message m WHERE m.session_id = s.id) +
             (SELECT count(*) FROM part    p WHERE p.session_id = s.id)
           ) AS size
         FROM session s`,
      )
      .all() as { id: string; mtime: number; size: number }[];
    return rows.map((r) => ({
      id: String(r.id),
      mtimeMs: Math.floor(Number(r.mtime)),
      size: Number(r.size),
    }));
  } finally {
    db.close();
  }
}

/** Read one session's metadata + messages + parts; `null` if the session is gone. */
export function readSession(dbPath: string, sessionId: string): OpencodeRawSession | null {
  if (!existsSync(dbPath)) return null;
  const db = open(dbPath);
  try {
    const s = db.prepare('SELECT id, directory, title FROM session WHERE id = ?').get(sessionId) as
      | { id: string; directory: string | null; title: string | null }
      | undefined;
    if (!s) return null;

    const messages = (
      db
        .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id')
        .all(sessionId) as { id: string; data: string }[]
    ).map((m) => ({ id: String(m.id), data: String(m.data) }));

    const partRows = db
      .prepare('SELECT message_id AS mid, data FROM part WHERE session_id = ? ORDER BY time_created, id')
      .all(sessionId) as { mid: string; data: string }[];
    const partsByMessage = new Map<string, string[]>();
    for (const p of partRows) {
      const list = partsByMessage.get(String(p.mid)) ?? [];
      list.push(String(p.data));
      partsByMessage.set(String(p.mid), list);
    }

    return {
      id: String(s.id),
      directory: String(s.directory ?? ''),
      title: String(s.title ?? ''),
      messages,
      partsByMessage,
    };
  } finally {
    db.close();
  }
}
