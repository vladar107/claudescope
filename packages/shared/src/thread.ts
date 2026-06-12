/**
 * Parsed thread types — the assembled, display-ready representation of a
 * session produced by the server's TypeScript parser from the raw events.
 */

import type {
  ContentBlock,
  MessageRole,
  MessageUsage,
  ModelId,
  TextBlock,
  ThinkingBlock,
} from './events.js';

/**
 * A tool_use paired with its (later-occurring) tool_result, joined by
 * `tool_use_id`. The result may be absent if the session ended before the
 * tool returned.
 */
export interface ToolInteraction {
  kind: 'tool';
  id: string;
  name: string;
  input: unknown;
  /** Resolved tool result, normalized to display blocks. May be undefined. */
  result?: {
    isError: boolean;
    /** tool_result.content normalized to an array of blocks. */
    content: ContentBlock[];
  };
}

export interface ParsedTextBlock extends TextBlock {
  kind: 'text';
}

/**
 * The raw block's `signature` is excluded: it renders nothing in the UI and is
 * pure payload weight (often megabytes across a large session).
 */
export interface ParsedThinkingBlock extends Omit<ThinkingBlock, 'signature'> {
  kind: 'thinking';
}

export interface ParsedAttachmentBlock {
  kind: 'attachment';
  attachment: unknown;
}

/** A single renderable element within a ThreadItem. */
export type ThreadBlock =
  | ParsedTextBlock
  | ParsedThinkingBlock
  | ToolInteraction
  | ParsedAttachmentBlock;

/**
 * One ordered message in an assembled session thread. Aggregates the parsed
 * blocks for a single user/assistant turn together with its metadata.
 */
export interface ThreadItem {
  uuid: string;
  parentUuid: string | null;
  role: MessageRole;
  timestamp: string;
  model?: ModelId;
  usage?: MessageUsage;
  isSidechain: boolean;
  blocks: ThreadBlock[];
}

/**
 * A subagent (sidechain) run: a complete sub-thread spawned by an `Agent`/`Task`
 * tool call in the main transcript. Returned alongside the main thread so the
 * UI can render each run nested at its spawn point rather than concatenated at
 * the end.
 */
export interface SubagentRun {
  /** Stable id from the subagent filename (`agent-<agentId>.jsonl`). */
  agentId: string;
  /** Subagent type from the `.meta.json` (e.g. "Explore", "general-purpose"). */
  agentType: string;
  /** Human-readable task description from the `.meta.json`. */
  description: string;
  /** Optional slug carried on the subagent's events. */
  slug?: string;
  /**
   * The main-thread `Agent`/`Task` tool_use id that spawned this run, when it
   * could be correlated (by description + type). Absent if unmatched.
   */
  toolUseId?: string;
  /** uuid of the main-thread turn carrying that tool_use (jump/anchor target). */
  spawnUuid?: string;
  /** Number of assembled turns in the subagent thread. */
  messageCount: number;
  /** Number of tool calls the subagent made. */
  toolCallCount: number;
  /** Total tokens (input + output + cache) across the subagent's turns. */
  totalTokens: number;
  /** The assembled subagent thread. */
  thread: ThreadItem[];
}
