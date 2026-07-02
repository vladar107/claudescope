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
  /** `session.parent_id` — set when this is a task-spawned child session. */
  parentId: string | null;
  /**
   * Root ancestor id (own id for a top-level session) — the indexing key, so a
   * task-spawned child folds into its parent session (the antigravity pattern).
   */
  rootId: string;
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

/**
 * Follow `parent_id` up to the top-level ancestor. Stops at a dangling link (the
 * parent row is gone — the walked-to session is then the root) and degrades to
 * the session's own id on a cycle (corrupt data must not re-key anything).
 */
function resolveRootId(
  db: InstanceType<typeof DatabaseSync>,
  id: string,
  firstParent: string | null,
): string {
  let rootId = id;
  let parentId = firstParent;
  const guard = new Set<string>([id]);
  const parentOf = db.prepare('SELECT parent_id FROM session WHERE id = ?');
  while (parentId) {
    if (guard.has(parentId)) return id; // cycle — treat as standalone
    const row = parentOf.get(parentId) as { parent_id: string | null } | undefined;
    if (!row) break; // dangling link — current rootId is the top
    guard.add(parentId);
    rootId = parentId;
    parentId = row.parent_id == null ? null : String(row.parent_id);
  }
  return rootId;
}

/** Read one session's metadata + messages + parts; `null` if the session is gone. */
export function readSession(dbPath: string, sessionId: string): OpencodeRawSession | null {
  if (!existsSync(dbPath)) return null;
  const db = open(dbPath);
  try {
    const s = db
      .prepare('SELECT id, directory, title, parent_id FROM session WHERE id = ?')
      .get(sessionId) as
      | { id: string; directory: string | null; title: string | null; parent_id: string | null }
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

    const id = String(s.id);
    const parentId = s.parent_id == null ? null : String(s.parent_id);
    return {
      id,
      directory: String(s.directory ?? ''),
      title: String(s.title ?? ''),
      parentId,
      rootId: parentId ? resolveRootId(db, id, parentId) : id,
      messages,
      partsByMessage,
    };
  } finally {
    db.close();
  }
}
