/**
 * GET /api/search — BM25 full-text search over event text.
 *
 * Uses the `fts` index built on `events.text_content` (keyed by `uuid`). Results
 * are ranked by `match_bm25` score and carry a snippet with the matched terms
 * highlighted via `<mark>`. Optional filters: `project` (slug) and `type`
 * (user|assistant|all).
 */

import type { FastifyInstance } from 'fastify';
import type { SearchResult, SearchType } from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { projectIdFromCwd } from '../data/project-id.js';

/** Max characters of context around the first match in a snippet. */
const SNIPPET_RADIUS = 120;

/** Escape HTML special chars so snippets are safe to render. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
    const re = new RegExp(`(${escapeRegExp(escapeHtml(t))})`, 'gi');
    escaped = escaped.replace(re, '<mark>$1</mark>');
  }
  return escaped;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function registerSearchRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { q?: string; project?: string; type?: string };
  }>('/api/search', async (req): Promise<SearchResult[]> => {
    const conn = await getConnection();
    const q = (req.query.q ?? '').trim();
    if (!q) return [];

    const type = (req.query.type as SearchType) ?? 'all';
    const project = req.query.project;

    // Filters reference the OUTER (projected) column names, not the inner
    // table aliases, since the bm25 score is computed in an inner subquery.
    const filters: string[] = ['score IS NOT NULL'];
    if (type === 'user' || type === 'assistant') {
      filters.push(`role = ${sqlString(type)}`);
    }
    if (project) {
      const cwds = await queryRows(
        conn,
        'SELECT DISTINCT project_cwd FROM sessions WHERE project_cwd IS NOT NULL',
      );
      const match = cwds
        .map((c) => String(c.project_cwd))
        .find((c) => projectIdFromCwd(c) === project);
      filters.push(`project_cwd = ${match ? sqlString(match) : "'\\0'"}`);
    }

    // match_bm25 takes the document key (uuid) and the raw query string.
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

    const terms = q.split(/\s+/).filter(Boolean);

    return rows.map((r): SearchResult => {
      const cwd = r.project_cwd != null ? String(r.project_cwd) : '';
      const text = r.text_content != null ? String(r.text_content) : '';
      return {
        sessionId: String(r.session_id),
        projectId: cwd ? projectIdFromCwd(cwd) : '',
        title: r.title != null ? String(r.title) : '',
        snippet: makeSnippet(text, terms),
        score: Number(r.score ?? 0),
        messageUuid: String(r.message_uuid),
        role: r.role != null ? String(r.role) : '',
      };
    });
  });
}
