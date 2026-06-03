import { useState } from 'react';
import { Collapsible } from './Collapsible.js';
import { Markdown } from './Markdown.js';

export interface ThinkingBlockProps {
  /** The model's extended-thinking text. */
  thinking: string;
  /** Open by default. Default false (collapsed). */
  defaultOpen?: boolean;
  /** Force the block open (e.g. it contains an in-session search match). */
  forceOpen?: boolean;
}

/**
 * Collapsible shell for an assistant extended-thinking block. Collapsed by
 * default and styled as muted/italic to distinguish it from visible output.
 */
export function ThinkingBlock({ thinking, defaultOpen = false, forceOpen = false }: ThinkingBlockProps) {
  // Claude Code transcripts persist only a thinking block's signature, not its
  // text, so `thinking` is empty in practice. Show a clear note rather than an
  // empty body so it doesn't look like a rendering bug.
  const hasText = thinking.trim().length > 0;
  const [userOpen, setUserOpen] = useState(defaultOpen);
  return (
    <Collapsible
      className="tv-collapsible--thinking"
      open={userOpen || forceOpen}
      onToggle={setUserOpen}
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
