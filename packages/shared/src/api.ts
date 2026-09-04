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
  /** Distinct model providers recorded on the session's assistant events (may be empty). */
  providers: string[];
  /** True when any recorded provider is zero-rated in pricing (a local runtime) — drives the "local" badge. */
  hasLocalProvider?: boolean;
  gitBranch?: string;
  prUrl?: string;
  sizeBytes: number;
  /** True when a sidechain/subagent subdirectory accompanies the session. */
  hasSidechain: boolean;
  /** Agent that produced this session, e.g. `claude-code` or `codex`. */
  connectorId: string;
  /**
   * Prompt size (input + cache read + cache write) of the last main-thread
   * assistant turn — the session's context as of that turn. Absent when the
   * agent's format has no per-response usage (Copilot, Antigravity, Junie).
   */
  contextTokens?: number;
  /** Context window of the model at that turn, when pricing knows it. */
  contextWindow?: number;
  /**
   * Main-thread context compactions. Absent when the agent's format carries no
   * compaction marker (opencode, Grok, Antigravity, Junie) — distinct from 0.
   */
  compactionCount?: number;
}

/** A single full-text search hit. */
export interface SearchResult {
  sessionId: string;
  projectId: string;
  title: string;
  /** Snippet with matched terms highlighted (HTML `<mark>`), or raw text with `format=plain`. */
  snippet: string;
  /** BM25 relevance score; 0 for `literal` hits, which are ordered by recency. */
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

export type SessionSort = 'recent' | 'oldest' | 'tokens' | 'cost' | 'messages' | 'context';

export interface SessionsQuery {
  project?: string;
  sort?: SessionSort;
  q?: string;
  /** Filter to a single agent connector id, e.g. `codex`. */
  agent?: string;
  /** Exact match on the session's recorded git branch. */
  branch?: string;
  /** Max rows returned (positive int). Absent = all rows (the web UI's default). */
  limit?: number;
}

/**
 * Windowing params for GET /api/sessions/:id — agent/CLI consumers slice large
 * sessions instead of downloading megabytes. `around` (a message uuid, e.g.
 * from a search hit) takes precedence over `offset`/`limit`. No params = the
 * full session, unchanged (the web UI's default).
 */
export interface SessionDetailQuery {
  /** 0-based index into the top-level thread. */
  offset?: number;
  /** Max thread items returned. */
  limit?: number;
  /** Center the window on this message uuid (`radius` items each side). */
  around?: string;
  /** Items on each side of `around` (default 10). */
  radius?: number;
  /** Return only the last N turns; exclusive with `offset`/`limit`/`around`. */
  tail?: number;
  /** Cap tool input/result strings at this many chars (with a truncation marker). */
  maxToolChars?: number;
}

export type SearchType = 'user' | 'assistant' | 'all';

/**
 * Where full-text search looks:
 * - `sessions` — transcripts only (default; the original behavior).
 * - `all` — transcripts **and** agent memory.
 * - `memory` — agent memory only.
 */
export type SearchScope = 'sessions' | 'all' | 'memory';

/**
 * Snippet rendering: `html` (default) escapes and wraps matches in `<mark>`;
 * `plain` returns the raw text window (for agent/CLI consumers).
 */
export type SnippetFormat = 'html' | 'plain';

export interface SearchQuery {
  q: string;
  project?: string;
  type?: SearchType;
  scope?: SearchScope;
  format?: SnippetFormat;
  /**
   * Exact mode: a case-insensitive substring match of the whole query over
   * transcript text, failed tool-result text, tool names and skill names,
   * newest first. No BM25 ranking — for error messages and identifiers that
   * tokenized search dilutes, and for the columns FTS doesn't index.
   */
  literal?: boolean;
}

export type AnalyticsGroupBy = 'project' | 'model' | 'day' | 'agent';

/** Shared date-range semantics for every analytics endpoint. */
export interface AnalyticsDateRangeQuery {
  /**
   * Inclusive ISO date/time lower bound. Date-only values are interpreted as
   * calendar days in `timeZone`; timestamps with an offset identify an instant.
   */
  from?: string;
  /**
   * Inclusive ISO date/time upper bound. A date-only value includes the whole
   * calendar day in `timeZone`.
   */
  to?: string;
  /** IANA time zone for date-only bounds and local-day grouping (default UTC at the raw HTTP API). */
  timeZone?: string;
}

/** GET /api/analytics query parameters; bounds filter event timestamps. */
export interface AnalyticsQuery extends AnalyticsDateRangeQuery {
  groupBy: AnalyticsGroupBy;
}

/** GET /api/analytics/digest query parameters; bounds filter session start timestamps. */
export type DigestQuery = AnalyticsDateRangeQuery;

// ---------------------------------------------------------------------------
// Session efficiency (per-session ratios)
// ---------------------------------------------------------------------------

/** Sortable columns for the session-efficiency table. */
export type SessionEfficiencySort =
  | 'title'
  | 'cost'
  | 'tokens'
  | 'responses'
  | 'duration'
  | 'cacheHitRatio'
  | 'costPerResponse'
  | 'tokensPerResponse'
  | 'toolCallCount'
  | 'toolCallsPerResponse'
  | 'contextTokens'
  | 'compactionCount';

/** Sort direction. */
export type SortDir = 'asc' | 'desc';

/** GET /api/analytics/sessions query parameters; bounds filter session start timestamps. */
export interface SessionEfficiencyQuery extends AnalyticsDateRangeQuery {
  /** Sort column (default 'cost'). */
  sort?: SessionEfficiencySort;
  /** Sort direction (default 'desc'). */
  dir?: SortDir;
  /** Max rows returned (default 50). */
  limit?: number;
  /** Minimum deduped assistant responses for a session to qualify (default 1, clamped ≥1). */
  minResponses?: number;
}

/** One session's efficiency row. Per-response ratios are always defined (D ≥ 1). */
export interface SessionEfficiencyRow {
  sessionId: string;
  title: string;
  titleDerived: boolean;
  projectId: string;
  projectDisplayName: string;
  connectorId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** D — deduped assistant responses. */
  responses: number;
  totalTokens: number;
  costUsd: number;
  toolCallCount: number;
  /** cache_read / (cache_read + cache_write + input), in [0, 1]. */
  cacheHitRatio: number;
  costPerResponse: number;
  tokensPerResponse: number;
  toolCallsPerResponse: number;
  /** Context at the last main-thread turn; null when the agent has no per-response usage. */
  contextTokens: number | null;
  /** Window of the model at that turn, when pricing knows it. */
  contextWindow: number | null;
  /** Main-thread compactions; null when the agent's format has no compaction marker. */
  compactionCount: number | null;
}

/**
 * Median + quartiles for one numeric column, over the FULL filtered set (not
 * just the returned rows). q1/q3 are the basis for the UI's IQR outlier fences.
 */
export interface SessionEfficiencyStat {
  median: number;
  q1: number;
  q3: number;
}

/** GET /api/analytics/sessions */
export interface SessionEfficiencyResponse {
  /** Top-N rows by the requested sort. */
  rows: SessionEfficiencyRow[];
  summary: {
    /** Qualifying sessions (post minResponses + date filter). */
    sessionCount: number;
    /** Total cost across the full filtered set. */
    totalCostUsd: number;
    /** Sum of the 3 highest session costs — for the spend-concentration insight. */
    top3CostUsd: number;
    /**
     * Per-column median + quartiles over the full filtered set. The UI shows the
     * median as the pinned reference row and derives IQR outlier fences from
     * q1/q3 for the cache-hit / $-per-response / tools-per-response columns.
     */
    columns: {
      responses: SessionEfficiencyStat;
      costUsd: SessionEfficiencyStat;
      costPerResponse: SessionEfficiencyStat;
      toolCallCount: SessionEfficiencyStat;
      toolCallsPerResponse: SessionEfficiencyStat;
      cacheHitRatio: SessionEfficiencyStat;
      /** Over sessions with a known context only. */
      contextTokens: SessionEfficiencyStat;
      /** Over sessions whose agent records compactions only. */
      compactionCount: SessionEfficiencyStat;
    };
  };
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

/**
 * Which slice of the thread a windowed session detail covers. Present only when
 * the request carried windowing params (`offset`/`limit`/`around`).
 */
export interface SessionWindow {
  /** 0-based index of the first returned thread item. */
  offset: number;
  /** Number of thread items returned. */
  limit: number;
  /** Total top-level thread items in the session. */
  total: number;
  /** For `around` requests: false when the uuid could not be located. */
  anchorFound?: boolean;
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
  /** Present when the response is a window over the thread (see {@link SessionWindow}). */
  window?: SessionWindow;
}

/** GET /api/sessions/:id/fingerprint */
export interface SessionFingerprintResponse {
  /**
   * Opaque change token over the session's files (live-statted per request).
   * Compare-only — clients must not parse it.
   */
  fingerprint: string;
  /** Max mtime (ms epoch) across the session's files; 0 when none could be statted. */
  lastModifiedMs: number;
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
  /** Snippet with matched terms in `<mark>` (HTML-escaped), or raw text with `format=plain`. */
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

export type ImpactGroupBy = 'agent' | 'day' | 'file';

/**
 * One code-impact aggregation row: agent-reported churn from canonical
 * Edit/MultiEdit/Write tool calls (deduped across fork copies at index time).
 * NOT git truth — reverted/overwritten edits count each time they were made.
 */
export interface ImpactRow {
  /** The group key value (connector id, YYYY-MM-DD day, or file path). */
  key: string;
  additions: number;
  deletions: number;
  /** Edit-bearing tool calls in the group. */
  edits: number;
  filesTouched: number;
  sessions: number;
}

export interface ImpactTotals {
  additions: number;
  deletions: number;
  edits: number;
  filesTouched: number;
  sessions: number;
}

/** GET /api/analytics/impact */
export interface ImpactResponse {
  rows: ImpactRow[];
  totals: ImpactTotals;
}

/** POST /api/reindex */
export interface ReindexResponse {
  reindexed: number;
  /**
   * Files the pass could not load (each isolated and skipped). Non-zero means
   * the index is STALE for those files, not that nothing changed — without this
   * a fully-failing pass is indistinguishable from a genuinely idle one.
   */
  failed: number;
  durationMs: number;
}

/** Live per-pass indexing progress: changed files loaded vs. total to load. */
export interface IndexingProgress {
  processed: number;
  total: number;
}

/** GET /api/health */
export interface HealthResponse {
  status: 'ok';
  version: string;
  /** True once the initial index build (or a post-rebuild pass) has finished. */
  ready: boolean;
  /**
   * Monotonic counter bumped whenever a reindex pass changed indexed data.
   * Clients refetch when it differs from the last value they saw (inequality,
   * not greater-than — the counter resets on daemon restart).
   */
  dataVersion: number;
  /** Present while a reindex pass is loading changed files. */
  indexing?: IndexingProgress;
  /** Latest published version, when the daemon knows it is newer than itself. */
  updateAvailable?: string;
  /** Compact indexer lifecycle state (full status lives on the action responses). */
  indexer?: Pick<IndexerStatus, 'state' | 'paused' | 'intervalMs'>;
}

// ---------------------------------------------------------------------------
// Settings & lifecycle
// ---------------------------------------------------------------------------

/** Where an effective setting value came from (precedence: env > file > default). */
export type SettingSource = 'env' | 'file' | 'default';

export type SettingValue = string | number | boolean;

/** One editable setting row, driven by the server-side registry. */
export interface EditableSetting {
  /** Registry key, e.g. `claudeProjectsDir`. */
  key: string;
  /** Human label, e.g. `Claude Code sessions`. */
  label: string;
  group: 'sources' | 'indexing' | 'startup';
  type: 'path' | 'number' | 'boolean';
  /** The env var that overrides this setting, e.g. `CLAUDE_PROJECTS_DIR`.
   *  Absent for settings with no env layer (e.g. `openBrowser`, whose
   *  `OPEN_BROWSER` env var is an internal launcher contract, not an override). */
  envVar?: string;
  /** The value currently in effect after precedence resolution. */
  effective: SettingValue;
  source: SettingSource;
  /** Saved settings.json value, when present (may be shadowed by env). */
  fileValue?: SettingValue;
  defaultValue: SettingValue;
  /** False → change takes effect on the next `claudescope start`. */
  live: boolean;
  /** Paths only: whether the effective path exists on disk. */
  exists?: boolean;
  /** Sources only: the connector this dir feeds, for UI labeling. */
  connectorId?: string;
}

/** A config value shown for transparency but not editable from the UI. */
export interface ReadOnlySetting {
  key: string;
  label: string;
  envVar?: string;
  value: string | number;
  source: SettingSource;
}

/** GET /api/settings */
export interface SettingsResponse {
  schemaVersion: number;
  editable: EditableSetting[];
  readOnly: ReadOnlySetting[];
}

/** PUT /api/settings — `null` clears a key back to its default. */
export interface SettingsUpdateRequest {
  set: Record<string, SettingValue | null>;
}

export interface SettingsUpdateResponse {
  /** Fresh post-save snapshot. */
  settings: SettingsResponse;
  applied: { key: string; live: boolean }[];
  warnings: { key: string; message: string }[];
}

/** Indexer lifecycle state (the poller + reindex engine, not the process). */
export interface IndexerStatus {
  state: 'building' | 'watching' | 'paused' | 'indexing';
  /** Runtime-only pause flag — not persisted; a restart resumes indexing. */
  paused: boolean;
  /** Effective auto-reindex interval (0 = disabled). */
  intervalMs: number;
  /** ISO timestamp of the last completed pass, if any. */
  lastPassAt: string | null;
  lastPass: ReindexResponse | null;
  rebuilding: boolean;
}

/** POST /api/index/rebuild → 202 */
export interface RebuildStartedResponse {
  started: true;
}

/** POST /api/pricing/refresh */
export interface PricingRefreshResponse {
  fetchedAt: string;
  modelCount: number;
  changed: number;
  /** Snapshot path, home dir contracted to `~`. */
  path: string;
}

/** GET /api/system — per-process statics for the Status/Update cards. */
export interface SystemInfoResponse {
  version: string;
  /** Latest published version, or null when offline / dev build. */
  latestVersion: string | null;
  updateAvailable: boolean;
  installMethod: 'npm' | 'brew' | 'nix';
  /** Exact upgrade command for the detected install method. */
  updateCommand: string;
  /** ISO timestamp of process start, for uptime display. */
  startedAt: string;
  dataVersion: number;
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

/**
 * A one-line content preview of a connector's most-recently-updated memory item,
 * for the memory landing card. Absent on the parent when the agent has no content.
 */
export interface MemoryPreview {
  title: string;
  category?: string;
  /** One-line description if present, else a short plain-text excerpt of the body. */
  description?: string;
  provenance: MemoryProvenance;
  kind: MemoryKind;
  scope: 'global' | 'project';
}

/**
 * Per-connector rollup for the memory landing page: counts plus a content
 * preview, listed for every agent detected on the current machine. Detected
 * agents that keep no memory store have `supported: false`.
 */
export interface MemoryConnectorOverview {
  connectorId: string;
  label: string;
  /** False when this agent keeps no memory store at all (no memory provider). */
  supported: boolean;
  /** Count of global user-authored instruction files (global sources). */
  globalFiles: number;
  /** Number of projects where this agent has any memory. */
  projectsWithFacts: number;
  /** Total memory items this agent contributes across all projects. */
  totalFacts: number;
  /** Most-recently-updated memory item (by mtime), for a one-line content preview. Absent when the agent has no content. */
  preview?: MemoryPreview;
}

/** GET /api/memory */
export interface MemoryResponse {
  global: GlobalMemory[];
  projects: ProjectMemorySummary[];
  /** One rollup per locally detected agent connector, for the landing-page cards. */
  connectors: MemoryConnectorOverview[];
}

/** GET /api/projects/:projectId/memory */
export type ProjectMemoryResponse = ProjectMemory;

// ---------------------------------------------------------------------------
// Analytics — activity heatmap and tool usage
// ---------------------------------------------------------------------------

/** One cell of the activity punchcard: prompts in (local) day-of-week × hour. */
export interface ActivityCell {
  /** ISO day of week: 1 = Monday … 7 = Sunday. */
  dow: number;
  /** Local hour, 0–23. */
  hour: number;
  count: number;
}

/** All-time prompt streak (consecutive local calendar days with ≥1 user prompt). */
export interface StreakInfo {
  current: number;
  longest: number;
  lastActiveDay: string | null;
}

/** GET /api/analytics/activity */
export interface ActivityResponse {
  heatmap: ActivityCell[];
  streak: StreakInfo;
}

/** Which breakdown `/api/analytics/tools` computes: raw tool calls, or (`skill`)
 *  canonical `Skill` tool_use calls counted by the skill they invoked. */
export type ToolUsageKind = 'tool' | 'skill';

/** GET /api/analytics/tools query parameters; bounds filter event timestamps. */
export interface ToolUsageQuery extends AnalyticsDateRangeQuery {
  /** Which breakdown to compute (default 'tool'). */
  kind?: ToolUsageKind;
  /** Project slug id (as returned by /api/projects); omit for the whole corpus. */
  project?: string;
}

/** One bar of the tool-usage breakdown: a raw (pre-categorization) tool name,
 *  attributed to the agent that emitted it. */
export interface ToolUsageRow {
  tool: string;
  /** Connector id of the agent that made the calls (e.g. 'claude-code', 'codex'). */
  agent: string;
  count: number;
}

/** GET /api/analytics/tools */
export interface ToolUsageResponse {
  rows: ToolUsageRow[];
}

// ---------------------------------------------------------------------------
// Analytics — error/interrupt signals and the periodic digest
// ---------------------------------------------------------------------------

/** One agent's error/interrupt signals (GET /api/analytics/errors). */
export interface ErrorAnalyticsRow {
  connectorId: string;
  sessions: number;
  /** Canonical tool calls (deduped, same semantics as the tools breakdown). */
  toolCalls: number;
  /**
   * Failed tool calls (`tool_error_count` sums). `null` when the source format
   * carries no error signal (Junie, Antigravity) — "can't know", never 0.
   */
  toolErrors: number | null;
  /** toolErrors / toolCalls; null when unknowable or there are no calls. */
  errorRate: number | null;
  /**
   * User interrupts (the `[Request interrupted by user…]` transcript marker).
   * Recorded by Claude Code only — null for every other agent.
   */
  interrupts: number | null;
  interruptsPerSession: number | null;
  /** Why a metric is n/a (or skewed), when it is. */
  availabilityNote?: string;
}

/** GET /api/analytics/errors */
export interface ErrorAnalyticsResponse {
  rows: ErrorAnalyticsRow[];
}

/** Digest totals — session-atomic: a session belongs to the range its start falls in. */
export interface DigestTotals {
  sessions: number;
  activeProjects: number;
  /** Canonical assistant responses. */
  responses: number;
  /** Token/cost sums cover only agents that report usage (Antigravity none; crashed Copilot sessions none). */
  totalTokens: number;
  costUsd: number;
}

export interface DigestProjectRow {
  projectId: string;
  cwd: string;
  sessions: number;
  totalTokens: number;
  costUsd: number;
}

/** A key → count line (model mix, tool mix, sessions per agent). */
export interface DigestCountRow {
  key: string;
  count: number;
}

export interface DigestBiggestSession {
  id: string;
  title: string;
  connectorId: string;
  costUsd: number;
  totalTokens: number;
}

/** Agent-reported churn over the range (see /api/analytics/impact — not git truth). */
export interface DigestImpact {
  additions: number;
  deletions: number;
  edits: number;
  filesTouched: number;
  /** Top files by churn (additions + deletions). */
  topFiles: { path: string; additions: number; deletions: number }[];
}

/** Tool-error rollup over agents whose formats record errors. */
export interface DigestErrors {
  toolCalls: number;
  toolErrors: number;
  errorRate: number | null;
  /** Agents in range whose formats carry no error signal (excluded from the counts). */
  unknownAgents: string[];
}

/** GET /api/analytics/digest */
export interface DigestResponse {
  /** Resolved inclusive range (ISO timestamps); defaults to the last 7 days. */
  from: string;
  to: string;
  totals: DigestTotals;
  topProjects: DigestProjectRow[];
  models: DigestCountRow[];
  topTools: DigestCountRow[];
  /** Sessions per agent. */
  agents: DigestCountRow[];
  biggestSession: DigestBiggestSession | null;
  /** All-time prompt streak (local days in the selected time zone) as of the range end. */
  streak: StreakInfo;
  impact: DigestImpact;
  /** null when no agent in range records tool errors. */
  errors: DigestErrors | null;
  /** Claude Code user interrupts in range; null when no Claude Code sessions. */
  interrupts: number | null;
}

// ---------------------------------------------------------------------------
// Analytics — cross-agent comparison
// ---------------------------------------------------------------------------

/**
 * How an agent records token usage — decides which comparison metrics are real
 * numbers and which are `null` ("not available", never 0):
 * - `per-response` — usage on each assistant message (claude-code, codex, pi,
 *   opencode, junie): every metric is real.
 * - `session-level` — one usage total per session (copilot, attached to the
 *   last response): session sums are real, per-response ratios are null.
 * - `none` — no token data at all (antigravity): all token/cost metrics null.
 */
export type AgentUsageGranularity = 'per-response' | 'session-level' | 'none';

/**
 * One agent's row in the cross-agent comparison. A `null` metric means the
 * agent's transcripts don't carry the data (see {@link AgentUsageGranularity}
 * and `availabilityNote`) — it must never be rendered as 0.
 */
export interface AgentComparisonRow {
  connectorId: string;
  usageGranularity: AgentUsageGranularity;
  /** Human explanation of any data gap, for the UI's n/a tooltips. */
  availabilityNote?: string;
  sessions: number;
  /** Deduped assistant responses (billed API calls for per-response agents). */
  responses: number;
  toolCalls: number;
  toolCallsPerResponse: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costPerSession: number | null;
  costPerResponse: number | null;
  tokensPerResponse: number | null;
  /** cache_read / (cache_read + cache_write + input), in [0, 1]. */
  cacheHitRatio: number | null;
  subagentSessions: number;
  /** subagentSessions / sessions; null when delegation is invisible (junie). */
  subagentShare: number | null;
  /**
   * Failed tool calls (`tool_error_count` sums). `null` when the source format
   * carries no error signal (Junie, Antigravity) — "can't know", never 0.
   */
  toolErrors: number | null;
  /** toolErrors / toolCalls; null when unknowable or there are no calls. */
  errorRate: number | null;
  /**
   * User interrupts (the `[Request interrupted by user…]` transcript marker).
   * Recorded by Claude Code only — null for every other agent.
   */
  interrupts: number | null;
}

/** Ride-along: sessions that produced a linked PR (recorded by Claude Code only). */
export interface PrLinkedStats {
  sessions: number;
  costUsd: number;
  /** costUsd / sessions; null when no PR-linked sessions are in scope. */
  costPerPrSession: number | null;
}

/** GET /api/analytics/agents query parameters; bounds filter session start timestamps. */
export interface AgentComparisonQuery extends AnalyticsDateRangeQuery {
  /** Project slug id (as returned by /api/projects); omit for the whole corpus. */
  project?: string;
}

/** GET /api/analytics/agents */
export interface AgentComparisonResponse {
  rows: AgentComparisonRow[];
  prLinked: PrLinkedStats;
}
