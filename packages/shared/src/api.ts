/**
 * API contract — request query shapes and response bodies for the server's
 * `/api/*` routes. Imported by both server (to implement) and web (to consume).
 */

import type { ModelId } from './events.js';
import type { SubagentRun, ThreadItem } from './thread.js';

// ---------------------------------------------------------------------------
// Domain summaries
// ---------------------------------------------------------------------------

/** Per-agent (connector) slice of a project's totals. */
export interface AgentBreakdown {
  /** Agent connector id, e.g. `claude-code` or `codex`. */
  connectorId: string;
  sessionCount: number;
  totalTokens: number;
  totalCostUsd: number;
}

/** Aggregated metadata for a project (a distinct real `cwd`). */
export interface ProjectMeta {
  /** Stable id derived from the canonical cwd. */
  id: string;
  cwd: string;
  /** Human-friendly name (typically the last path segment of cwd). */
  displayName: string;
  sessionCount: number;
  totalTokens: number;
  totalCostUsd: number;
  /** ISO timestamp of the most recent activity. */
  lastActive: string;
  /** Distinct agent connector ids whose sessions live under this cwd. */
  connectorIds: string[];
  /** Per-agent breakdown of the project totals, sorted by tokens desc. */
  agents: AgentBreakdown[];
}

/** Aggregated metadata for a single session. */
export interface SessionMeta {
  id: string;
  projectId: string;
  /** Human-friendly project name (last path segment of the project cwd). */
  projectDisplayName: string;
  title: string;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  toolCallCount: number;
  totalTokens: number;
  totalCostUsd: number;
  models: ModelId[];
  gitBranch?: string;
  prUrl?: string;
  sizeBytes: number;
  /** True when a sidechain/subagent subdirectory accompanies the session. */
  hasSidechain: boolean;
  /** Agent that produced this session, e.g. `claude-code` or `codex`. */
  connectorId: string;
}

/** A single full-text search hit. */
export interface SearchResult {
  sessionId: string;
  projectId: string;
  title: string;
  /** Snippet with matched terms highlighted (HTML `<mark>`). */
  snippet: string;
  /** BM25 relevance score. */
  score: number;
  messageUuid: string;
  role: string;
}

/** One row of an analytics aggregation, grouped per `groupBy`. */
export interface AnalyticsRow {
  /** The group key value (project id, model id, or YYYY-MM-DD day). */
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  /** cache_read / (cache_read + input), in [0, 1]. */
  cacheHitRatio: number;
  messageCount: number;
}

export interface AnalyticsTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  cacheHitRatio: number;
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Request query parameter shapes
// ---------------------------------------------------------------------------

export type SessionSort = 'recent' | 'oldest' | 'tokens' | 'cost' | 'messages';

export interface SessionsQuery {
  project?: string;
  sort?: SessionSort;
  q?: string;
  /** Filter to a single agent connector id, e.g. `codex`. */
  agent?: string;
}

export type SearchType = 'user' | 'assistant' | 'all';

export interface SearchQuery {
  q: string;
  project?: string;
  type?: SearchType;
}

export type AnalyticsGroupBy = 'project' | 'model' | 'day' | 'agent';

export interface AnalyticsQuery {
  groupBy: AnalyticsGroupBy;
  /** Inclusive ISO date/time lower bound. */
  from?: string;
  /** Inclusive ISO date/time upper bound. */
  to?: string;
}

// ---------------------------------------------------------------------------
// Response bodies
// ---------------------------------------------------------------------------

/** GET /api/projects */
export type ProjectsResponse = ProjectMeta[];

/** GET /api/sessions */
export type SessionsResponse = SessionMeta[];

/** GET /api/sessions/:id */
export interface SessionDetailResponse {
  meta: SessionMeta;
  /** The main transcript thread (subagent turns are NOT inlined here). */
  thread: ThreadItem[];
  /** Subagent runs, each linked to its spawn point via `toolUseId`/`spawnUuid`. */
  subagents: SubagentRun[];
}

/** GET /api/search */
export type SearchResponse = SearchResult[];

/** One read-only source directory backing an agent connector. */
export interface SourceInfo {
  /** Connector id, e.g. `claude-code` or `codex`. */
  id: string;
  /** Human-friendly agent label. */
  label: string;
  /** Source directory, with the home dir contracted to `~`. */
  path: string;
}

/** GET /api/sources */
export type SourcesResponse = SourceInfo[];

/** GET /api/analytics */
export interface AnalyticsResponse {
  rows: AnalyticsRow[];
  totals: AnalyticsTotals;
}

/** POST /api/reindex */
export interface ReindexResponse {
  reindexed: number;
  durationMs: number;
}

/** GET /api/health */
export interface HealthResponse {
  status: 'ok';
  version: string;
}
