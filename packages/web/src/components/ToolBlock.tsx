import type { ContentBlock, ToolInteraction } from '@claudescope/shared';
import { Collapsible } from './Collapsible.js';
import { Markdown } from './Markdown.js';

export interface ToolBlockProps {
  /** The parsed tool interaction (tool_use paired with its tool_result). */
  tool: ToolInteraction;
  /** Open by default. Default false (collapsed for dense reading). */
  defaultOpen?: boolean;
}

/** Pretty-print a tool's `input` (unknown JSON) for display. */
function stringifyInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Render normalized tool_result content blocks. Text/JSON shown as text. */
function renderResultBlocks(blocks: ContentBlock[]) {
  return blocks.map((block, i) => {
    if (block.type === 'text') {
      return <Markdown key={i} markdown={false}>{block.text}</Markdown>;
    }
    if (block.type === 'thinking') {
      return <Markdown key={i} markdown={false}>{block.thinking}</Markdown>;
    }
    // tool_use / tool_result nested or rich content (e.g. images): dump JSON.
    return (
      <Markdown key={i} markdown={false}>
        {stringifyInput(block)}
      </Markdown>
    );
  });
}

/**
 * Collapsible shell for a single tool call. Shows the tool name + id in the
 * header, the input JSON, and the (optional) result. Feature agents can use
 * this as-is or compose around the underlying {@link Collapsible}.
 */
export function ToolBlock({ tool, defaultOpen = false }: ToolBlockProps) {
  const isError = tool.result?.isError === true;
  const className = isError ? 'tv-collapsible--tool tv-collapsible--error' : 'tv-collapsible--tool';

  return (
    <Collapsible
      className={className}
      defaultOpen={defaultOpen}
      icon="⚙"
      title={tool.name}
      subtitle={tool.id}
      headerExtra={
        isError ? (
          <span className="tv-chip" style={{ color: 'var(--tv-danger)' }}>
            error
          </span>
        ) : null
      }
    >
      <div className="tv-tool__section">
        <p className="tv-tool__section-label">Input</p>
        <Markdown markdown={false}>{stringifyInput(tool.input)}</Markdown>
      </div>
      {tool.result ? (
        <div className="tv-tool__section">
          <p className="tv-tool__section-label">{isError ? 'Result (error)' : 'Result'}</p>
          {renderResultBlocks(tool.result.content)}
        </div>
      ) : (
        <div className="tv-tool__section">
          <p className="tv-tool__section-label tv-muted">No result (pending or session ended)</p>
        </div>
      )}
    </Collapsible>
  );
}
