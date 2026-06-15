/**
 * GET /api/search — full-text search over transcripts and/or agent memory.
 *
 * Transcripts use the BM25 `fts` index on `events.text_content` (keyed by
 * `uuid`); memory is searched live (it isn't indexed). The `scope` param picks
 * which: `sessions` (default), `all` (both), or `memory` (memory only). Both
 * kinds carry a snippet with matched terms highlighted via `<mark>`. Optional
 * filters: `project` (slug) and `type` (user|assistant|all; sessions only).
 */

import type { FastifyInstance } from 'fastify';
import type {
  MemorySearchHit,
  SearchResponse,
  SearchResult,
  SearchScope,
  SearchType,
} from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { projectIdFromCwd } from '../data/project-id.js';
import { collectMemory } from '../data/memory.js';

/** Max characters of context around the first match in a snippet. */
const SNIPPET_RADIUS = 120;
/** Cap on live memory hits returned. */
const MEMORY_LIMIT = 50;

/** Escape HTML special chars so snippets are safe to render. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a highlighted snippet: find the first occurrence of any query term in
 * the text, return a window around it, and wrap matching terms in <mark>.
 */
function makeSnippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let firstIdx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (firstIdx === -1 || i < firstIdx)) firstIdx = i;
  }
  const start = firstIdx === -1 ? 0 : Math.max(0, firstIdx - SNIPPET_RADIUS);
  const end = Math.min(text.length, (firstIdx === -1 ? 0 : firstIdx) + SNIPPET_RADIUS * 2);
  let window = text.slice(start, end);
  if (start > 0) window = '…' + window;
  if (end < text.length) window = window + '…';

  let escaped = escapeHtml(window);
  for (const t of terms) {
    if (!t) continue;
    escaped = escaped.replace(new RegExp(`(${escapeRegExp(escapeHtml(t))})`, 'gi'), '<mark>$1</mark>');
  }
  return escaped;
}

/** Sessions (BM25) search. Empty unless scope includes sessions. */
async function searchSessions(
  q: string,
  terms: string[],
  type: SearchType,
  project: string | undefined,
): Promise<SearchResult[]> {
  const conn = await getConnection();
  // `events.uuid` is duplicated by fork/resume copies (the same lines re-listed
  // under a new session id), so `match_bm25(uuid, …)` — whose internal lookup is
  // a scalar subquery keyed by uuid — can hit multiple rows. Newer DuckDB errors
  // on that; this restores the prior "pick a representative row" behavior (the
  // duplicates are identical copies, so any is fine). Pre-existing issue on main.
  await conn.run('SET scalar_subquery_error_on_multiple_rows = false');

  const filters: string[] = ['score IS NOT NULL'];
  if (type === 'user' || type === 'assistant') filters.push(`role = ${sqlString(type)}`);
  if (project) {
    const cwds = await queryRows(
      conn,
      'SELECT DISTINCT project_cwd FROM sessions WHERE project_cwd IS NOT NULL',
    );
    const match = cwds.map((c) => String(c.project_cwd)).find((c) => projectIdFromCwd(c) === project);
    filters.push(`project_cwd = ${match ? sqlString(match) : "'\\0'"}`);
  }

  const rows = await queryRows(
    conn,
    `SELECT * FROM (
       SELECT
         e.uuid AS message_uuid,
         e.session_id AS session_id,
         e.role AS role,
         e.text_content AS text_content,
         s.project_cwd AS project_cwd,
         s.title AS title,
         fts_main_events.match_bm25(e.uuid, ${sqlString(q)}) AS score
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       WHERE e.text_content IS NOT NULL
     )
     WHERE ${filters.join(' AND ')}
     ORDER BY score DESC
     LIMIT 50`,
  );

  return rows.map((r): SearchResult => {
    const rd = readRow(r, 'search');
    const cwd = rd.str('project_cwd');
    const text = rd.str('text_content');
    return {
      sessionId: rd.str('session_id'),
      projectId: cwd ? projectIdFromCwd(cwd) : '',
      title: rd.str('title'),
      snippet: makeSnippet(text, terms),
      score: rd.num('score'),
      messageUuid: rd.str('message_uuid'),
      role: rd.str('role'),
    };
  });
}

/** Live memory search. Empty unless scope includes memory. */
async function searchMemory(
  terms: string[],
  project: string | undefined,
): Promise<MemorySearchHit[]> {
  const lowered = terms.map((t) => t.toLowerCase());
  const items = await collectMemory();
  const scored: { hits: number; hit: MemorySearchHit }[] = [];

  for (const it of items) {
    // A project filter restricts to that project's facts (drops global memory).
    if (project && (it.scope !== 'project' || it.projectId !== project)) continue;

    const s = it.source;
    const haystack = `${s.title}\n${s.description ?? ''}\n${s.category ?? ''}\n${s.markdown}`.toLowerCase();
    const hits = lowered.filter((t) => t && haystack.includes(t)).length;
    if (hits === 0) continue;

    // Snippet from the body where possible, else the title.
    const bodyHasTerm = lowered.some((t) => t && s.markdown.toLowerCase().includes(t));
    const snippet = makeSnippet(bodyHasTerm ? s.markdown : s.title, terms);

    scored.push({
      hits,
      hit: {
        connectorId: it.connectorId,
        label: it.label,
        scope: it.scope,
        ...(it.projectId ? { projectId: it.projectId } : {}),
        ...(it.projectDisplayName ? { projectDisplayName: it.projectDisplayName } : {}),
        title: s.title,
        ...(s.category ? { category: s.category } : {}),
        snippet,
        sourcePath: s.sourcePath,
        ...(s.originSessionId ? { originSessionId: s.originSessionId } : {}),
      },
    });
  }

  return scored
    .sort((a, b) => b.hits - a.hits)
    .slice(0, MEMORY_LIMIT)
    .map((x) => x.hit);
}

export async function registerSearchRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { q?: string; project?: string; type?: string; scope?: string };
  }>('/api/search', async (req): Promise<SearchResponse> => {
    const q = (req.query.q ?? '').trim();
    if (!q) return { sessions: [], memory: [] };

    const terms = q.split(/\s+/).filter(Boolean);
    const type = (req.query.type as SearchType) ?? 'all';
    const project = req.query.project;
    const scope = (req.query.scope as SearchScope) ?? 'sessions';

    // Each kind is guarded so a failure in one (e.g. an FTS edge case) still
    // returns the other rather than 500-ing the whole request.
    const sessions =
      scope === 'memory' ? [] : await searchSessions(q, terms, type, project).catch(() => []);
    const memory = scope === 'sessions' ? [] : await searchMemory(terms, project).catch(() => []);

    return { sessions, memory };
  });
}
