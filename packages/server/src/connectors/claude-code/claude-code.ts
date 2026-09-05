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
import { claudeProjectsDir } from '../../settings.js';
import { sqlPath, sqlString } from '../../db/duckdb.js';
import type { SessionData, SubagentSource } from '../../data/session-loader.js';
import type { AgentConnector, AuxProjections, DiscoveredFile } from '../types.js';
import { MAX_TOOL_ERROR_TEXT } from '../tool-errors.js';
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
 * One failed tool_result's body. `content` is either a plain string or an array
 * of blocks (a tool returning an image alongside its message), and DuckDB
 * reports those as json_type 'VARCHAR' and 'ARRAY' respectively; the array form
 * keeps its text items only. Any other shape yields NULL, which `string_agg`
 * then skips.
 */
const ERROR_BODY = `
        CASE json_type(b.value, '$.content')
          WHEN 'VARCHAR' THEN json_extract_string(b.value, '$.content')
          WHEN 'ARRAY' THEN array_to_string(
            list_filter(
              list_transform(
                CAST(json_extract(b.value, '$.content') AS JSON[]),
                x -> CASE WHEN json_extract_string(x, '$.type') = 'text'
                          THEN json_extract_string(x, '$.text') END
              ),
              t -> t IS NOT NULL
            ), chr(10))
        END`;

/**
 * One shared pass over a message's content blocks, as a LATERAL join: plain
 * text (text/thinking bodies for FTS), tool_use count + names, the skill
 * argument of `Skill` calls, and the count and bodies of tool_results flagged
 * `is_error` — six aggregates from a single `json_each` scan per row
 * (correlated subqueries would re-scan the array per aggregate, which
 * measurably slows cold indexing). For a plain-string `content` the scan yields
 * scalar rows no block filter matches, so every aggregate comes back empty and
 * the CASEs in the SELECT keep the original per-shape semantics (string
 * content → its text, zero tools).
 */
const BLOCK_AGG_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (
        WHERE json_extract_string(b.value, '$.type') = 'tool_use'
      ) AS tool_use_count,
      string_agg(json_extract_string(b.value, '$.name'), ',') FILTER (
        WHERE json_extract_string(b.value, '$.type') = 'tool_use'
          AND json_extract_string(b.value, '$.name') IS NOT NULL
      ) AS tool_names,
      count(*) FILTER (
        WHERE json_extract_string(b.value, '$.type') = 'tool_result'
          AND json_extract_string(b.value, '$.is_error') = 'true'
      ) AS tool_error_count,
      string_agg(${ERROR_BODY}, chr(10)) FILTER (
        WHERE json_extract_string(b.value, '$.type') = 'tool_result'
          AND json_extract_string(b.value, '$.is_error') = 'true'
      ) AS tool_error_text,
      string_agg(json_extract_string(b.value, '$.input.skill'), ',') FILTER (
        WHERE json_extract_string(b.value, '$.type') = 'tool_use'
          AND json_extract_string(b.value, '$.name') = 'Skill'
          AND json_type(b.value, '$.input.skill') = 'VARCHAR'
          AND json_extract_string(b.value, '$.input.skill') <> ''
      ) AS skill_names,
      string_agg(
        coalesce(
          json_extract_string(b.value, '$.text'),
          json_extract_string(b.value, '$.thinking')
        ),
        ' '
      ) FILTER (
        WHERE json_extract_string(b.value, '$.type') IN ('text', 'thinking')
      ) AS block_text
    FROM json_each(message, '$.content') AS b
  ) blocks ON TRUE`;

/** True when the message's `content` is a plain string rather than blocks. */
const STRING_CONTENT = `json_type(message -> '$.content') = 'VARCHAR'`;

/**
 * FTS-searchable plain text: the string content itself, or the concatenated
 * text/thinking block bodies (NULL when there are none).
 */
const TEXT_CONTENT_EXPR = `
  CASE
    WHEN message IS NULL THEN NULL
    WHEN ${STRING_CONTENT} THEN json_extract_string(message, '$.content')
    ELSE blocks.block_text
  END`;

/** Count of `tool_use` blocks (0 for strings). */
const TOOL_USE_COUNT_EXPR = `
  CASE
    WHEN message IS NULL OR ${STRING_CONTENT} THEN 0
    ELSE COALESCE(blocks.tool_use_count, 0)
  END`;

/**
 * Count of `tool_result` blocks flagged `is_error` (0 for strings/no errors).
 * Claude Code records the flag natively, so the count is always known — never
 * NULL (unlike Junie/Antigravity).
 */
const TOOL_ERROR_COUNT_EXPR = `
  CASE
    WHEN message IS NULL OR ${STRING_CONTENT} THEN 0
    ELSE COALESCE(blocks.tool_error_count, 0)
  END`;

/** Comma-joined `$.name` of `tool_use` blocks ('' when there are none). */
const TOOL_NAMES_EXPR = `
  CASE
    WHEN message IS NULL OR ${STRING_CONTENT} THEN ''
    ELSE COALESCE(blocks.tool_names, '')
  END`;

/**
 * Newline-joined bodies of the failed tool_results, capped per event so a single
 * multi-megabyte failure (a truncated build log) can't bloat the index. NULL
 * when the row has no failed result — this is search material, not a count.
 */
const TOOL_ERROR_TEXT_EXPR = `
  CASE
    WHEN message IS NULL OR ${STRING_CONTENT} THEN NULL
    ELSE left(blocks.tool_error_text, ${MAX_TOOL_ERROR_TEXT})
  END`;

/** Comma-joined `$.input.skill` of `Skill` tool_use blocks ('' when none). */
const SKILL_NAMES_EXPR = `
  CASE
    WHEN message IS NULL OR ${STRING_CONTENT} THEN ''
    ELSE COALESCE(blocks.skill_names, '')
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

  walk(claudeProjectsDir());
  return out;
}

/** Project a Claude transcript file into the canonical `events` columns. */
function eventsProjectionSql(filePath: string): string {
  const path = sqlString(filePath);
  const readPath = sqlPath(filePath);
  const readFn = `read_ndjson(${readPath}, ${READ_OPTS}, columns={
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
      CAST(NULL AS VARCHAR) AS provider,
      COALESCE(try_cast(json_extract(message, '$.usage.input_tokens') AS BIGINT), 0) AS input_tokens,
      COALESCE(try_cast(json_extract(message, '$.usage.output_tokens') AS BIGINT), 0) AS output_tokens,
      COALESCE(try_cast(json_extract(message, '$.usage.cache_read_input_tokens') AS BIGINT), 0) AS cache_read_tokens,
      COALESCE(try_cast(json_extract(message, '$.usage.cache_creation_input_tokens') AS BIGINT), 0) AS cache_write_tokens,
      json_extract_string(message, '$.usage.service_tier') AS service_tier,
      COALESCE(isSidechain, FALSE) AS is_sidechain,
      ${TOOL_USE_COUNT_EXPR} AS tool_use_count,
      ${TOOL_NAMES_EXPR} AS tool_names,
      ${TOOL_ERROR_COUNT_EXPR} AS tool_error_count,
      ${TOOL_ERROR_TEXT_EXPR} AS tool_error_text,
      ${SKILL_NAMES_EXPR} AS skill_names,
      ${TEXT_CONTENT_EXPR} AS text_content,
      json_extract_string(message, '$.id') AS message_id,
      json_extract_string(forkedFrom, '$.sessionId') AS forked_from_session_id
    FROM ${readFn}
    ${BLOCK_AGG_LATERAL}
    WHERE type IN ('user', 'assistant')`;
}

/** ai-title and pr-link projections (session-keyed) plus compactions (file-keyed). */
function auxProjections(filePath: string): AuxProjections {
  const path = sqlString(filePath);
  const readPath = sqlPath(filePath);
  const readFn = `read_ndjson(${readPath}, ${READ_OPTS}, columns={
    type:'VARCHAR', sessionId:'VARCHAR', aiTitle:'VARCHAR',
    prNumber:'BIGINT', prRepository:'VARCHAR', prUrl:'VARCHAR'
  })`;
  // Compaction markers live on records the events projection filters out
  // (`system`) or on a flagged user turn, so they need their own column map.
  const compactionReadFn = `read_ndjson(${readPath}, ${READ_OPTS}, columns={
    type:'VARCHAR', subtype:'VARCHAR', isCompactSummary:'BOOLEAN', uuid:'VARCHAR',
    sessionId:'VARCHAR', timestamp:'VARCHAR', isSidechain:'BOOLEAN',
    compactMetadata:'JSON'
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
    // The web UI renders pr_url verbatim as an `<a href>`, so only http(s) is admitted.
    prLinks: `
      SELECT sessionId,
             arg_max(prNumber, prUrl) AS pr_number,
             arg_max(prRepository, prUrl) AS pr_repository,
             max(prUrl) AS pr_url
      FROM ${readFn}
      WHERE type = 'pr-link' AND sessionId IS NOT NULL AND prUrl IS NOT NULL
        AND regexp_matches(prUrl, '^https?://')
      GROUP BY sessionId`,
    // One row per compaction. Current Claude Code writes a `compact_boundary`
    // system record; the 2025 format instead flagged the summary user turn with
    // `isCompactSummary`, and files from the transition carry BOTH for a single
    // compaction. So flagged summaries only count in a file with no boundary at
    // all — the conservative direction, where a wrong guess under-counts rather
    // than doubling. `MATERIALIZED` keeps the NOT EXISTS check from reading the
    // transcript a second time.
    compactions: `
      WITH marks AS MATERIALIZED (
        SELECT type, uuid, sessionId, timestamp, isSidechain, compactMetadata
        FROM ${compactionReadFn}
        WHERE sessionId IS NOT NULL
          AND ((type = 'system' AND subtype = 'compact_boundary')
               OR (type = 'user' AND COALESCE(isCompactSummary, FALSE)))
      )
      SELECT
        ${path} AS file_path,
        sessionId AS session_id,
        uuid,
        try_cast(timestamp AS TIMESTAMP) AS ts,
        COALESCE(isSidechain, FALSE) AS is_sidechain,
        json_extract_string(compactMetadata, '$.trigger') AS trigger,
        try_cast(json_extract(compactMetadata, '$.preTokens') AS BIGINT) AS pre_tokens,
        try_cast(json_extract(compactMetadata, '$.postTokens') AS BIGINT) AS post_tokens
      FROM marks
      WHERE type = 'system' OR NOT EXISTS (SELECT 1 FROM marks WHERE type = 'system')`,
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

/**
 * Read the sibling `agent-<id>.meta.json`. Current Claude Code writes
 * `{agentType, description, toolUseId, spawnDepth}`, plus `parentAgentId` when
 * a SUBAGENT made the call — a depth-2 run is a sibling file in the same
 * `subagents/` dir, and its `toolUseId` names an `Agent` call inside the
 * depth-1 transcript. Older metadata has only `agentType`, so every field is
 * optional and the description/prompt fallback stays. `spawnDepth` is not read:
 * depth follows from the parent chain.
 */
function readSubagentMeta(jsonlPath: string): {
  agentType: string;
  description: string;
  toolUseId?: string;
  parentAgentId?: string;
} {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      agentType?: unknown;
      description?: unknown;
      toolUseId?: unknown;
      parentAgentId?: unknown;
    };
    const toolUseId = typeof parsed.toolUseId === 'string' ? parsed.toolUseId : '';
    const parentAgentId = typeof parsed.parentAgentId === 'string' ? parsed.parentAgentId : '';
    return {
      agentType: typeof parsed.agentType === 'string' ? parsed.agentType : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      ...(toolUseId ? { toolUseId } : {}),
      ...(parentAgentId ? { parentAgentId } : {}),
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

/** Full text of the first non-empty user message, if one is available. */
function firstUserPrompt(events: RawEvent[]): string | undefined {
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
    if (text.trim().length > 0) return text;
  }
  return undefined;
}

/** A concise display label derived from a subagent's full first prompt. */
function deriveLabel(prompt: string): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
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
    const prompt = firstUserPrompt(events);
    // Workflow agents have no meta description; fall back to their first prompt.
    const description = meta.description || (prompt ? deriveLabel(prompt) : '');
    subagents.push({
      agentId: agentIdFromPath(p),
      agentType: meta.agentType,
      description,
      ...(meta.toolUseId ? { toolUseId: meta.toolUseId } : {}),
      ...(meta.parentAgentId ? { parentAgentId: meta.parentAgentId } : {}),
      ...(slug ? { slug } : {}),
      ...(prompt ? { prompt } : {}),
      ...(workflowId ? { workflowId } : {}),
      events,
    });
  }

  return { mainEvents, subagents };
}

export const claudeCodeConnector: AgentConnector = {
  id: 'claude-code',
  label: 'Claude Code',
  // Resolved per access so a settings.json change applies without a restart.
  get sourceDir() {
    return claudeProjectsDir();
  },
  discover,
  eventsProjectionSql,
  auxProjections,
  loadSession,
  globalMemory,
  projectMemory,
  resumeSpec: (id) => ({
    resumeArgv: ['claude', '--resume', id],
    forkArgv: ['claude', '--resume', id, '--fork-session'],
  }),
};
