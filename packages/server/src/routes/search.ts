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
  SearchType,
  SnippetFormat,
} from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { readRow } from '../db/row.js';
import { projectIdFromCwd } from '../data/project-id.js';
import { projectFilter } from '../data/analytics-scope.js';
import { collectMemory } from '../data/memory.js';
import { enumParam } from '../params.js';
import { makeSnippet } from './snippet.js';

/** Cap on live memory hits returned. */
const MEMORY_LIMIT = 50;
const SEARCH_TYPES = ['user', 'assistant', 'all'] as const;
const SEARCH_SCOPES = ['sessions', 'all', 'memory'] as const;

/** Sessions (BM25) search. Empty unless scope includes sessions. */
async function searchSessions(
  q: string,
  terms: string[],
  type: SearchType,
  project: string | undefined,
  format: SnippetFormat,
): Promise<SearchResult[]> {
  // NOTE: this query depends on `scalar_subquery_error_on_multiple_rows = false`,
  // which is applied once when the connection opens (see db/duckdb.ts) rather than
  // here — it is a connection-level setting, and the connection is shared.
  const conn = await getConnection();
  const identifierQuery = /\d/.test(q);
  const matchExpression = `fts_main_events.match_bm25(
    e.uuid,
    ${sqlString(q)}${identifierQuery ? ', conjunctive := true' : ''}
  )`;

  const filters: string[] = ['score IS NOT NULL'];
  if (type === 'user' || type === 'assistant') filters.push(`role = ${sqlString(type)}`);
  if (project) filters.push(await projectFilter(conn, project));

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
         ${
           identifierQuery
             ? `contains(lower(e.text_content), ${sqlString(q.toLowerCase())})`
             : 'FALSE'
         } AS exact_match,
         ${matchExpression} AS score
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       WHERE e.text_content IS NOT NULL
     )
     WHERE ${filters.join(' AND ')}
     ORDER BY exact_match DESC, score DESC
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
      snippet: makeSnippet(text, terms, format),
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
  format: SnippetFormat,
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
    const snippet = makeSnippet(bodyHasTerm ? s.markdown : s.title, terms, format);

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
    Querystring: { q?: string; project?: string; type?: string; scope?: string; format?: string };
  }>('/api/search', async (req): Promise<SearchResponse> => {
    const q = (req.query.q ?? '').trim();
    if (!q) return { sessions: [], memory: [] };

    const terms = q.split(/\s+/).filter(Boolean);
    const type = enumParam(req.query.type, 'type', SEARCH_TYPES, 'all');
    const project = req.query.project;
    const scope = enumParam(req.query.scope, 'scope', SEARCH_SCOPES, 'sessions');
    const format: SnippetFormat = req.query.format === 'plain' ? 'plain' : 'html';

    // Each kind is guarded so a failure in one (e.g. an FTS edge case) still
    // returns the other rather than 500-ing the whole request.
    const sessions =
      scope === 'memory'
        ? []
        : await searchSessions(q, terms, type, project, format).catch((err) => {
            // Don't 500 the whole request, but don't let a real FTS regression
            // silently look like "no results" either — leave a trace.
            req.log.warn({ err }, 'session search failed');
            return [];
          });
    const memory =
      scope === 'sessions'
        ? []
        : await searchMemory(terms, project, format).catch((err) => {
            req.log.warn({ err }, 'memory search failed');
            return [];
          });

    return { sessions, memory };
  });
}
