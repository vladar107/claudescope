/**
 * Loads the raw events of a single session directly from disk for the
 * session-detail endpoint.
 *
 * A session is stored as `<project>/<sessionId>.jsonl`, optionally accompanied
 * by subagent transcripts at `<project>/<sessionId>/subagents/agent-*.jsonl`,
 * each with a sibling `agent-*.meta.json` ({ agentType, description }). The
 * subagent files carry the same `sessionId` with `isSidechain=true`.
 *
 * Rather than concatenating everything into one stream, we return the main
 * transcript events separately from each subagent's events (plus its metadata),
 * so the thread assembler can present subagents nested at their spawn point.
 *
 * File lookup is via the `files` table (authoritative — the on-disk filename
 * usually equals the sessionId but the indexer records the real path), so this
 * never has to guess the encoded directory name.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RawEvent } from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';

/** One subagent transcript: its metadata plus its raw events. */
export interface SubagentSource {
  agentId: string;
  agentType: string;
  description: string;
  slug?: string;
  /**
   * Workflow run id (e.g. `wf_…`) when this agent was spawned by a `Workflow`
   * tool call — derived from its `subagents/workflows/<wfId>/` path. Lets the
   * builder nest all of a workflow's agents under that one tool call.
   */
  workflowId?: string;
  events: RawEvent[];
}

/** A session's events split into the main transcript and its subagent runs. */
export interface SessionData {
  mainEvents: RawEvent[];
  subagents: SubagentSource[];
}

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
 * of subagent runs. Returns empty collections if the session is unknown.
 */
export async function loadSessionData(sessionId: string): Promise<SessionData> {
  const conn = await getConnection();

  const rows = await queryRows(
    conn,
    `SELECT path FROM files WHERE session_id = ${sqlString(sessionId)}`,
  );
  const paths = rows.map((r) => String(r.path)).filter((p) => existsSync(p));
  if (paths.length === 0) return { mainEvents: [], subagents: [] };

  // Subagent files live under `<sessionId>/subagents`; everything else is main.
  const marker = `${join(sessionId, 'subagents')}`;
  const mainFiles = paths.filter((p) => !p.includes(marker)).sort();
  const subFiles = paths.filter((p) => p.includes(marker)).sort();

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
