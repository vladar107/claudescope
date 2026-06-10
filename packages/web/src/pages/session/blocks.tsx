import { memo } from 'react';
import type { ThreadBlock } from '@claudescope/shared';
import { Markdown, ThinkingBlock, ToolBlock } from '../../components';
import { stripImageMarkers } from './text.js';

/**
 * Render a single parsed thread block by its `kind` discriminator.
 * - text: markdown
 * - thinking: collapsible muted block
 * - tool: paired tool_use + tool_result (handles missing result + is_error)
 * - attachment: unknown/rich block (e.g. image) surfaced safely
 *
 * Memoized: blocks are immutable for the life of a session payload, so when a
 * finder step re-renders the thread via context, only the block whose
 * `forceOpen` flipped actually recomputes.
 */
export const ThreadBlockView = memo(function ThreadBlockView({
  block,
  forceOpen = false,
}: {
  block: ThreadBlock;
  /** Force a collapsible block (thinking/tool) open — used by in-session search. */
  forceOpen?: boolean;
}) {
  switch (block.kind) {
    case 'text': {
      const text = stripImageMarkers(block.text);
      return text ? <Markdown forceExpand={forceOpen}>{text}</Markdown> : null;
    }
    case 'thinking':
      return <ThinkingBlock thinking={block.thinking} forceOpen={forceOpen} />;
    case 'tool':
      return <ToolBlock tool={block} forceOpen={forceOpen} />;
    case 'attachment':
      return <AttachmentView attachment={block.attachment} />;
  }
});

/**
 * Best-effort rendering for attachment blocks. Image blocks (the observed
 * unknown raw type) are shown inline when a data/url source is present;
 * everything else is dumped as readable JSON.
 */
function AttachmentView({ attachment }: { attachment: unknown }) {
  const img = extractImage(attachment);
  if (img) {
    return (
      <figure className="tv-attachment">
        <img src={img} alt="attachment" />
        <figcaption className="tv-muted">image attachment</figcaption>
      </figure>
    );
  }
  let text: string;
  try {
    text = JSON.stringify(attachment, null, 2);
  } catch {
    text = String(attachment);
  }
  return (
    <div className="tv-attachment">
      <div className="tv-tool__section-label">Attachment</div>
      <Markdown markdown={false}>{text}</Markdown>
    </div>
  );
}

/** Pull a renderable <img src> out of an Anthropic-style image block, if any. */
function extractImage(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const block = value as { type?: string; source?: unknown };
  if (block.type !== 'image' || !block.source || typeof block.source !== 'object') return null;
  const source = block.source as {
    type?: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
  if (source.type === 'url' && source.url) return source.url;
  if (source.type === 'base64' && source.data && source.media_type) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return null;
}

/** True when a thread item carries any non-whitespace renderable block. */
export function hasRenderableContent(blocks: ThreadBlock[]): boolean {
  return blocks.some((b) => {
    if (b.kind === 'text') return stripImageMarkers(b.text).length > 0;
    return true;
  });
}
