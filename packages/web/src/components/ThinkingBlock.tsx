import { Collapsible } from './Collapsible.js';
import { Markdown } from './Markdown.js';

export interface ThinkingBlockProps {
  /** The model's extended-thinking text. */
  thinking: string;
  /** Open by default. Default false (collapsed). */
  defaultOpen?: boolean;
}

/**
 * Collapsible shell for an assistant extended-thinking block. Collapsed by
 * default and styled as muted/italic to distinguish it from visible output.
 */
export function ThinkingBlock({ thinking, defaultOpen = false }: ThinkingBlockProps) {
  // Claude Code transcripts persist only a thinking block's signature, not its
  // text, so `thinking` is empty in practice. Show a clear note rather than an
  // empty body so it doesn't look like a rendering bug.
  const hasText = thinking.trim().length > 0;
  return (
    <Collapsible
      className="tv-collapsible--thinking"
      defaultOpen={defaultOpen}
      icon="💭"
      title="Thinking"
    >
      {hasText ? (
        <Markdown>{thinking}</Markdown>
      ) : (
        <p className="tv-muted" style={{ fontStyle: 'italic', margin: 0 }}>
          Thinking content isn’t stored in the transcript (only a signature).
        </p>
      )}
    </Collapsible>
  );
}
