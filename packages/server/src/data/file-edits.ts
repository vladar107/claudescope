/**
 * Index-time extraction of `file_edits` rows — the code-impact analog of the
 * events load.
 *
 * The extraction unit is the SESSION (a session's edits span its main +
 * subagent files), so the indexer hands over every session touched by a pass
 * (loaded, reloaded, or losing a file) and this module deletes + re-extracts
 * those sessions' rows. The heavy lifting reuses the exact session-view path —
 * `loadSessionData` → thread assembly → the shared changeset collector — so
 * every connector normalization guarantee (Codex/opencode apply_patch fan-out,
 * Copilot's only-successful-edits rule, Junie's full-file before/after blocks)
 * holds here for free.
 *
 * Fork/resume copies duplicate edit calls across sessions with uuid and
 * tool_use_id preserved; {@link electCanonicalEdits} marks one row per
 * (uuid, tool_use_id, file_path) as the counted one, preferring the original
 * over fork copies — mirroring `electCanonicalUsage`.
 */

import type { DuckDBConnection } from '@duckdb/node-api';
import { collectEditCalls, fileStats } from '@claudescope/shared';
import { queryRows, sqlString } from '../db/duckdb.js';
import { assembleThread, buildSubagentRuns } from './parser.js';
import { loadSessionData } from './session-loader.js';

/** Insert batch size — keeps the VALUES statement well under DuckDB limits. */
const INSERT_CHUNK = 500;

/**
 * Sessions whose events actually contain an edit-bearing canonical tool.
 * `tool_names` is a comma-joined CSV, so a substring match is a safe pre-filter
 * ('Edit' also matches MultiEdit; a false positive only costs a parse that
 * finds no canonical edit blocks).
 */
async function editBearing(conn: DuckDBConnection, sessionIds: string[]): Promise<string[]> {
  // Chunked for the same reason the DELETE in refreshFileEdits is: on a cold
  // build EVERY session is touched, so an unchunked IN list is one statement
  // carrying the whole corpus (~147 KB of SQL at 5k sessions).
  const out: string[] = [];
  for (let i = 0; i < sessionIds.length; i += INSERT_CHUNK) {
    const ids = sessionIds
      .slice(i, i + INSERT_CHUNK)
      .map(sqlString)
      .join(', ');
    const rows = await queryRows(
      conn,
      `SELECT DISTINCT session_id FROM events
       WHERE session_id IN (${ids})
         AND (tool_names LIKE '%Edit%' OR tool_names LIKE '%Write%')`,
    );
    for (const r of rows) out.push(String(r.session_id));
  }
  return out;
}

/**
 * Delete + re-extract `file_edits` for the given sessions. A session that no
 * longer has files (fully removed) simply loses its rows; a session with no
 * edit-bearing events is deleted but never parsed (tool_names pre-filter).
 */
export async function refreshFileEdits(
  conn: DuckDBConnection,
  sessionIds: Iterable<string>,
): Promise<void> {
  const affected = [...new Set(sessionIds)].filter((s) => s.length > 0);
  if (affected.length === 0) return;

  for (let i = 0; i < affected.length; i += INSERT_CHUNK) {
    const ids = affected
      .slice(i, i + INSERT_CHUNK)
      .map(sqlString)
      .join(', ');
    await conn.run(`DELETE FROM file_edits WHERE session_id IN (${ids})`);
  }

  const toExtract = await editBearing(conn, affected);
  for (const sessionId of toExtract) {
    // Isolate per-session failures like loadFile isolates per-file ones: one
    // unparseable session must not abort the whole pass.
    try {
      const { mainEvents, subagents } = await loadSessionData(sessionId);
      if (mainEvents.length === 0 && subagents.length === 0) continue;
      const thread = assembleThread(mainEvents);
      const runs = buildSubagentRuns(thread, subagents);

      const values: string[] = [];
      for (const call of collectEditCalls(thread, runs)) {
        const { additions, deletions } = fileStats(call.edits);
        values.push(
          `(${sqlString(sessionId)}, ${sqlString(call.uuid)}, ${sqlString(call.toolUseId)},
            try_cast(${sqlString(call.timestamp)} AS TIMESTAMP), ${call.isSidechain},
            ${sqlString(call.toolName)}, ${sqlString(call.path)}, ${additions}, ${deletions}, TRUE)`,
        );
      }
      for (let i = 0; i < values.length; i += INSERT_CHUNK) {
        await conn.run(
          `INSERT INTO file_edits VALUES ${values.slice(i, i + INSERT_CHUNK).join(', ')}`,
        );
      }
    } catch (err) {
      console.warn(`claudescope: skipping file-edit extraction for session ${sessionId}:`, err);
    }
  }
}

/**
 * Mark exactly one `file_edits` row per (uuid, tool_use_id, file_path) as the
 * counted one. Duplicates only arise from fork/resume copies (uuids are
 * session-scoped or globally unique in every connector), and the fork copy's
 * events carry `forked_from_session_id` — prefer rows whose session events
 * don't, then a deterministic session_id tiebreak. Runs globally each changed
 * pass (cheap at this scale), so it stays correct when the original file is
 * later deleted: the surviving fork copy gets re-elected.
 */
export async function electCanonicalEdits(conn: DuckDBConnection): Promise<void> {
  await conn.run(`UPDATE file_edits SET edit_canonical = TRUE`);
  await conn.run(`
    UPDATE file_edits SET edit_canonical = FALSE
    FROM (
      SELECT session_id, uuid, tool_use_id, file_path,
             row_number() OVER (
               PARTITION BY uuid, tool_use_id, file_path
               ORDER BY forked ASC, session_id
             ) AS rn
      FROM (
        SELECT fe.session_id, fe.uuid, fe.tool_use_id, fe.file_path,
               COALESCE(bool_or(e.forked_from_session_id IS NOT NULL), FALSE) AS forked
        FROM file_edits fe
        LEFT JOIN events e ON e.session_id = fe.session_id AND e.uuid = fe.uuid
        GROUP BY fe.session_id, fe.uuid, fe.tool_use_id, fe.file_path
      )
    ) w
    WHERE file_edits.session_id = w.session_id
      AND file_edits.uuid = w.uuid
      AND file_edits.tool_use_id = w.tool_use_id
      AND file_edits.file_path = w.file_path
      AND w.rn > 1
  `);
}
