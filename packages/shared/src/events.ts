/**
 * Raw event types as they appear on disk in the Claude Code session JSONL files.
 *
 * Each line of a `<session-uuid>.jsonl` file is exactly one of these events.
 * These shapes are derived from the on-disk data and treated as ground truth;
 * the server's DuckDB layer reads the `message` field as JSON, while the small
 * TypeScript parser assembles a thread using the typed shapes below.
 *
 * IMPORTANT: the on-disk format is append-only and partly schema-loose. Fields
 * beyond the ones modeled here may exist; unknown fields are tolerated. The
 * `cwd` / `gitBranch` fields inside events are the source of truth for project
 * identity, NOT the (lossy) encoded directory name.
 */

/** All ten observed `type` discriminator values for raw events. */
export type RawEventType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'attachment'
  | 'file-history-snapshot'
  | 'permission-mode'
  | 'ai-title'
  | 'last-prompt'
  | 'pr-link'
  | 'queue-operation';

/** Model identifier. `<synthetic>` denotes locally generated (zero-cost) output. */
export type ModelId = string;

export type MessageRole = 'user' | 'assistant';

// ---------------------------------------------------------------------------
// Content blocks (inside message.content when it is an array)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  /** Cryptographic signature attached by the API to extended-thinking blocks. */
  signature?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  /** Present when the tool call originated from a nested caller (e.g. a subagent). */
  caller?: unknown;
}

/**
 * A tool_result block. `content` is USUALLY a string but can ALSO be an array
 * of blocks (e.g. image + text from a tool that returns rich output). Both
 * shapes must be handled by consumers.
 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

/**
 * An image block. Claude emits these inline; the Codex connector maps its
 * `input_image` items here too. The frontend renders a `base64` or `url` source
 * (a data URL counts as a `url`).
 */
export interface ImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}

/** Any block that can appear inside an array-valued `message.content`. */
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

/** `message.content` is either a plain string or an array of blocks. */
export type MessageContent = string | ContentBlock[];

// ---------------------------------------------------------------------------
// Usage / cost accounting (assistant events only)
// ---------------------------------------------------------------------------

export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Nested breakdown of cache-creation tokens by ephemeral TTL bucket. */
  cache_creation?: Record<string, number>;
  service_tier?: string;
  speed?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Message object (carried by user & assistant events)
// ---------------------------------------------------------------------------

export interface RawMessage {
  role: MessageRole;
  content: MessageContent;
  /** Assistant-only fields below. */
  id?: string;
  model?: ModelId;
  type?: string;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  stop_details?: unknown;
  usage?: MessageUsage;
}

// ---------------------------------------------------------------------------
// Common envelope shared by conversational events
// ---------------------------------------------------------------------------

interface EventEnvelope {
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd: string;
  gitBranch?: string;
  version?: string;
  userType?: string;
  isSidechain?: boolean;
  entrypoint?: string;
}

// ---------------------------------------------------------------------------
// Concrete raw event variants (discriminated by `type`)
// ---------------------------------------------------------------------------

export interface UserEvent extends EventEnvelope {
  type: 'user';
  message: RawMessage;
  permissionMode?: string;
  promptId?: string;
  /**
   * Claude Code (2025 format): this user turn IS the post-compaction summary.
   * Current Claude Code writes a `system` `compact_boundary` row instead (see
   * {@link SystemEvent}); mid-period files carry both for one compaction.
   */
  isCompactSummary?: boolean;
}

export interface AssistantEvent extends EventEnvelope {
  type: 'assistant';
  message: RawMessage;
  requestId?: string;
}

/** Claude Code's `compactMetadata` on a `compact_boundary` system row. */
export interface CompactMetadata {
  /** `auto` or `manual`. */
  trigger?: string;
  /** Context size (tokens) just before / after the compaction. */
  preTokens?: number;
  postTokens?: number;
  [key: string]: unknown;
}

/**
 * A `subtype: 'compact_boundary'` system event marks a context compaction that
 * happened right before the next conversational event. Claude Code writes these
 * natively; the Codex/pi/Copilot normalizers synthesize the same shape so one
 * parser path and one index projection serve every agent.
 */
export interface SystemEvent extends EventEnvelope {
  type: 'system';
  subtype?: string;
  isMeta?: boolean;
  messageCount?: number;
  durationMs?: number;
  content?: string;
  compactMetadata?: CompactMetadata;
  /** Synthetic only (Codex/pi): the plaintext compaction summary, when stored. */
  summary?: string;
}

export interface AttachmentEvent extends EventEnvelope {
  type: 'attachment';
  attachment: unknown;
}

export interface FileHistorySnapshotEvent {
  type: 'file-history-snapshot';
  messageId?: string;
  isSnapshotUpdate?: boolean;
  snapshot: unknown;
}

export interface PermissionModeEvent {
  type: 'permission-mode';
  sessionId: string;
  permissionMode: string;
}

export interface AiTitleEvent {
  type: 'ai-title';
  sessionId: string;
  aiTitle: string;
}

export interface LastPromptEvent {
  type: 'last-prompt';
  sessionId: string;
  lastPrompt: string;
  leafUuid?: string;
}

export interface PrLinkEvent {
  type: 'pr-link';
  sessionId: string;
  prNumber: number;
  prRepository: string;
  prUrl: string;
  timestamp?: string;
}

export interface QueueOperationEvent {
  type: 'queue-operation';
  sessionId: string;
  operation: string;
  content?: string;
  timestamp?: string;
}

/** Discriminated union over every raw event variant found on disk. */
export type RawEvent =
  | UserEvent
  | AssistantEvent
  | SystemEvent
  | AttachmentEvent
  | FileHistorySnapshotEvent
  | PermissionModeEvent
  | AiTitleEvent
  | LastPromptEvent
  | PrLinkEvent
  | QueueOperationEvent;
