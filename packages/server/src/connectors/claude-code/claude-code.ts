/**
 * Claude Code connector — the reference {@link AgentConnector}.
 *
 * Source layout: `~/.claude/projects/<encoded-cwd>/<session>.jsonl`, with
 * sidechain/subagent transcripts in a `<session>/subagents/agent-*.jsonl`
 * subtree (each with a sibling `agent-*.meta.json`). All Claude-format knowledge
 * — the JSONL record shape, the content-block model, the subagent layout — lives
 * here; the indexer and session route stay format-agnostic.
 *
 * STRICTLY READ-ONLY with respect to ~/.claude — files are only ever read.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RawEvent } from '@claudescope/shared';
import { CLAUDE_PROJECTS_DIR } from '../../config.js';
import { sqlString } from '../../db/duckdb.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { globalMemory, projectMemory } from './memory.js';

/**
 * Shared `read_ndjson` options for the line-delimited Claude transcripts.
 * `ignore_errors=true` makes DuckDB skip a malformed/partial line (e.g. a
 * transcript written mid-flush, or one with an unescaped control character)
 * instead of failing the whole file read — which would otherwise abort the
 * entire reindex. The JS session-detail parser tolerates such lines too.
 */
const READ_OPTS = `union_by_name=true, format='newline_delimited', maximum_object_size=268435456, ignore_errors=true`;

/**
 * SQL extracting FTS-searchable plain text from a `message` JSON value.
 * `message.content` is either a plain string or an array of blocks; for arrays
 * we concatenate the `text`/`thinking` block bodies.
 */
const TEXT_CONTENT_EXPR = `
  CASE
    WHEN message IS NULL THEN NULL
    WHEN json_type(message -> '$.content') = 'VARCHAR'
      THEN json_extract_string(message, '$.content')
    ELSE (
      SELECT string_agg(
        coalesce(
          json_extract_string(b.value, '$.text'),
          json_extract_string(b.value, '$.thinking')
        ),
        ' '
      )
      FROM json_each(message, '$.content') AS b
      WHERE json_extract_string(b.value, '$.type') IN ('text', 'thinking')
    )
  END`;

/** Count of `tool_use` blocks inside a message's content array (0 for strings). */
const TOOL_USE_COUNT_EXPR = `
  CASE
    WHEN message IS NULL OR json_type(message -> '$.content') = 'VARCHAR' THEN 0
    ELSE (
      SELECT count(*)
      FROM json_each(message, '$.content') AS b
      WHERE json_extract_string(b.value, '$.type') = 'tool_use'
    )
  END`;

/**
 * Recursively collect every `*.jsonl` file under the projects directory. The
 * top level holds `<encoded-cwd>/<session>.jsonl`; sidechain events live in a
 * `<session-uuid>/` subdirectory beside the file, so we recurse.
 */
function discover(): DiscoveredFile[] {
  const out: DiscoveredFile[] = [];

  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const st = statSync(full);
          out.push({ path: full, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
        } catch {
          /* file vanished between readdir and stat; ignore */
        }
      }
    }
  };

  walk(CLAUDE_PROJECTS_DIR);
  return out;
}

/** Project a Claude transcript file into the canonical `events` columns. */
function eventsProjectionSql(filePath: string): string {
  const path = sqlString(filePath);
  const readFn = `read_ndjson(${path}, ${READ_OPTS}, columns={
    type:'VARCHAR', uuid:'VARCHAR', parentUuid:'VARCHAR', sessionId:'VARCHAR',
    timestamp:'VARCHAR', cwd:'VARCHAR', gitBranch:'VARCHAR', isSidechain:'BOOLEAN',
    message:'JSON', forkedFrom:'JSON'
  })`;

  return `
    SELECT
      ${path} AS file_path,
      sessionId AS session_id,
      uuid,
      parentUuid AS parent_uuid,
      json_extract_string(message, '$.role') AS role,
      type,
      try_cast(timestamp AS TIMESTAMP) AS ts,
      cwd,
      gitBranch AS git_branch,
      json_extract_string(message, '$.model') AS model,
      COALESCE(try_cast(json_extract(message, '$.usage.input_tokens') AS BIGINT), 0) AS input_tokens,
      COALESCE(try_cast(json_extract(message, '$.usage.output_tokens') AS BIGINT), 0) AS output_tokens,
      COALESCE(try_cast(json_extract(message, '$.usage.cache_read_input_tokens') AS BIGINT), 0) AS cache_read_tokens,
      COALESCE(try_cast(json_extract(message, '$.usage.cache_creation_input_tokens') AS BIGINT), 0) AS cache_write_tokens,
      json_extract_string(message, '$.usage.service_tier') AS service_tier,
      COALESCE(isSidechain, FALSE) AS is_sidechain,
      ${TOOL_USE_COUNT_EXPR} AS tool_use_count,
      ${TEXT_CONTENT_EXPR} AS text_content,
      json_extract_string(message, '$.id') AS message_id,
      json_extract_string(forkedFrom, '$.sessionId') AS forked_from_session_id
    FROM ${readFn}
    WHERE type IN ('user', 'assistant')`;
}

/** ai-title and pr-link projections, keyed by session. */
function auxProjections(filePath: string): AuxProjections {
  const path = sqlString(filePath);
  const readFn = `read_ndjson(${path}, ${READ_OPTS}, columns={
    type:'VARCHAR', sessionId:'VARCHAR', aiTitle:'VARCHAR',
    prNumber:'BIGINT', prRepository:'VARCHAR', prUrl:'VARCHAR'
  })`;
  return {
    // ai-title: latest non-null title in the file wins.
    titles: `
      SELECT sessionId, last(aiTitle) AS title
      FROM ${readFn}
      WHERE type = 'ai-title' AND sessionId IS NOT NULL AND aiTitle IS NOT NULL
      GROUP BY sessionId`,
    // pr-link: one PR per session, picked deterministically. pr-link records
    // carry no timestamp, and three independent last() aggregates could both flip
    // across reindexes and stitch fields from different rows. Keying all three on
    // the same max(prUrl) row (prUrl is always present per the WHERE) is a stable
    // total order, so the fields always come from one record and never drop a link.
    prLinks: `
      SELECT sessionId,
             arg_max(prNumber, prUrl) AS pr_number,
             arg_max(prRepository, prUrl) AS pr_repository,
             max(prUrl) AS pr_url
      FROM ${readFn}
      WHERE type = 'pr-link' AND sessionId IS NOT NULL AND prUrl IS NOT NULL
      GROUP BY sessionId`,
  };
}

// --- session detail loading -------------------------------------------------

/** Parse a JSONL file into RawEvent[], skipping blank/corrupt lines. */
function parseJsonl(path: string): RawEvent[] {
  const out: RawEvent[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as RawEvent);
    } catch {
      /* tolerate a corrupt/partial trailing line */
    }
  }
  return out;
}

function timestampOf(e: RawEvent): string {
  return 'timestamp' in e && typeof e.timestamp === 'string' ? e.timestamp : '';
}

/** Derive the agent id from a `…/agent-<agentId>.jsonl` path. */
function agentIdFromPath(path: string): string {
  return basename(path).replace(/^agent-/, '').replace(/\.jsonl$/, '');
}

/** Read the sibling `agent-<id>.meta.json` ({ agentType, description }). */
function readSubagentMeta(jsonlPath: string): { agentType: string; description: string } {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      agentType?: unknown;
      description?: unknown;
    };
    return {
      agentType: typeof parsed.agentType === 'string' ? parsed.agentType : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
    };
  } catch {
    return { agentType: '', description: '' };
  }
}

/** First non-empty `slug` found on the subagent's events, if any. */
function firstSlug(events: RawEvent[]): string | undefined {
  for (const e of events) {
    const slug = (e as unknown as Record<string, unknown>).slug;
    if (typeof slug === 'string' && slug.length > 0) return slug;
  }
  return undefined;
}

/** Workflow run id from a `…/subagents/workflows/<wfId>/agent-*.jsonl` path. */
function workflowIdFromPath(path: string): string | undefined {
  const m = path.match(/[/\\]workflows[/\\]([^/\\]+)[/\\]/);
  return m ? m[1] : undefined;
}

/**
 * A readable label for a subagent that lacks a meta description (e.g. workflow
 * agents): the first line of its first user message, truncated.
 */
function deriveLabel(events: RawEvent[]): string {
  for (const e of events) {
    if (e.type !== 'user') continue;
    const content = (e as { message?: { content?: unknown } }).message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      const first = content.find(
        (b): b is { type: string; text: string } =>
          !!b && typeof b === 'object' && (b as { type?: string }).type === 'text',
      );
      text = first?.text ?? '';
    }
    const line = text.trim().split('\n')[0]?.trim() ?? '';
    if (line) return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  }
  return '';
}

/**
 * Load a session's events from disk, split into the main transcript and a list
 * of subagent runs. `paths` are all files recorded for the session.
 */
async function loadSession(sessionId: string, paths: string[]): Promise<SessionData> {
  const present = paths.filter((p) => existsSync(p));
  if (present.length === 0) return { mainEvents: [], subagents: [] };

  // Subagent files live under `<sessionId>/subagents`; everything else is main.
  const marker = `${join(sessionId, 'subagents')}`;
  const mainFiles = present.filter((p) => !p.includes(marker)).sort();
  const subFiles = present.filter((p) => p.includes(marker)).sort();

  const mainEvents: RawEvent[] = [];
  for (const p of mainFiles) mainEvents.push(...parseJsonl(p));

  const subagents: SubagentSource[] = [];
  for (const p of subFiles) {
    const events = parseJsonl(p);
    events.sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)));
    const meta = readSubagentMeta(p);
    const slug = firstSlug(events);
    const workflowId = workflowIdFromPath(p);
    // Workflow agents have no meta description; fall back to their first prompt.
    const description = meta.description || deriveLabel(events);
    subagents.push({
      agentId: agentIdFromPath(p),
      agentType: meta.agentType,
      description,
      ...(slug ? { slug } : {}),
      ...(workflowId ? { workflowId } : {}),
      events,
    });
  }

  return { mainEvents, subagents };
}

export const claudeCodeConnector: AgentConnector = {
  id: 'claude-code',
  label: 'Claude Code',
  sourceDir: CLAUDE_PROJECTS_DIR,
  discover,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  globalMemory,
  projectMemory,
};
