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
  /**
   * True when `title` was derived from the (cleaned) first user message rather
   * than a real stored title — e.g. Codex/pi sessions, which store no title.
   * Lets the UI mark it "untitled · from first message". Optional/back-compat.
   */
  titleDerived?: boolean;
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

/**
 * Where full-text search looks:
 * - `sessions` — transcripts only (default; the original behavior).
 * - `all` — transcripts **and** agent memory.
 * - `memory` — agent memory only.
 */
export type SearchScope = 'sessions' | 'all' | 'memory';

export interface SearchQuery {
  q: string;
  project?: string;
  type?: SearchType;
  scope?: SearchScope;
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

/**
 * The command(s) to reopen a session in the agent's own CLI, for the user to
 * copy and run. Present only when the session's connector knows a resume command
 * (all current agents). Built server-side from the indexed session id + cwd.
 */
export interface ResumeInfo {
  /** Working directory the command runs in. */
  cwd: string;
  /** POSIX command that appends to the original session. */
  resumeCommand: string;
  /** POSIX command that forks into a new session; absent when the agent has no CLI fork. */
  forkCommand?: string;
}

/** GET /api/sessions/:id */
export interface SessionDetailResponse {
  meta: SessionMeta;
  /** The main transcript thread (subagent turns are NOT inlined here). */
  thread: ThreadItem[];
  /** Subagent runs, each linked to its spawn point via `toolUseId`/`spawnUuid`. */
  subagents: SubagentRun[];
  /** Resume/fork commands for this session, when the connector supports it. */
  resume?: ResumeInfo;
}

/** A full-text search hit in agent memory (instruction file or distilled fact). */
export interface MemorySearchHit {
  connectorId: string;
  /** Human-friendly agent label. */
  label: string;
  /** `global` instruction file/handbook, or a per-project `project` fact. */
  scope: 'global' | 'project';
  /** Present for project facts; absent for global memory. */
  projectId?: string;
  projectDisplayName?: string;
  title: string;
  category?: string;
  /** Snippet with matched terms in `<mark>` (the server HTML-escapes the rest). */
  snippet: string;
  /** Source path, home contracted to `~`. */
  sourcePath: string;
  /** Claude facts: the session that produced the fact (deep-link). */
  originSessionId?: string;
}

/** GET /api/search */
export interface SearchResponse {
  sessions: SearchResult[];
  memory: MemorySearchHit[];
}

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

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Where a piece of memory came from:
 * - `user-authored` — instruction files the user wrote (CLAUDE.md, AGENTS.md).
 * - `agent-authored` — memory the agent distilled on its own (Claude facts,
 *   Codex's memories handbook).
 */
export type MemoryProvenance = 'user-authored' | 'agent-authored';

/**
 * Structural shape of a memory item:
 * - `fact` — a single typed fact with frontmatter (Claude `memory/*.md`).
 * - `document` — a named markdown/JSON file rendered whole (Codex `MEMORY.md`).
 */
export type MemoryKind = 'fact' | 'document';

/**
 * One unit of memory from an agent. Read live from disk (never indexed). For
 * Claude facts, `category` is one of `user` | `feedback` | `project` |
 * `reference`; other agents may use free-form categories.
 */
export interface MemorySource {
  provenance: MemoryProvenance;
  kind: MemoryKind;
  /** Fact name or document label, e.g. `cost-double-counting` or `Codex handbook`. */
  title: string;
  /** One-line description (Claude facts), when present. */
  description?: string;
  /** Fact type (Claude) or category; see {@link MemorySource}. */
  category?: string;
  /** Markdown body, rendered read-only. */
  markdown: string;
  /** Source path with the home dir contracted to `~`, for provenance display. */
  sourcePath: string;
  /** ISO timestamp of last modification (file mtime). */
  updatedAt: string;
  /** Claude: the session that produced this fact — a deep-link target. */
  originSessionId?: string;
  /** Claude: `[[wiki-link]]` fact names referenced in the body. */
  relatedNames?: string[];
  /** True when the store exists but is an empty scaffold (no content yet). */
  empty?: boolean;
}

/** Global, cross-project memory contributed by one connector. */
export interface GlobalMemory {
  connectorId: string;
  /** Human-friendly agent label, e.g. `Claude Code`. */
  label: string;
  sources: MemorySource[];
}

/** Memory for one project from one connector. */
export interface ProjectAgentMemory {
  connectorId: string;
  label: string;
  sources: MemorySource[];
}

/** Per-project memory grouped by agent. */
export interface ProjectMemory {
  projectId: string;
  /** Human-friendly project name, when the project is known to the index. */
  displayName?: string;
  byAgent: ProjectAgentMemory[];
}

/** Which projects have any agent memory, with per-connector counts. */
export interface ProjectMemorySummary {
  projectId: string;
  displayName: string;
  counts: { connectorId: string; count: number }[];
}

/** GET /api/memory */
export interface MemoryResponse {
  global: GlobalMemory[];
  projects: ProjectMemorySummary[];
}

/** GET /api/projects/:projectId/memory */
export type ProjectMemoryResponse = ProjectMemory;
