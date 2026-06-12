/**
 * Utilities for resolving Anthropic-style image content blocks to renderable
 * <img src> strings.
 */

/**
 * Pull a renderable `<img src>` string out of an Anthropic-style image block.
 *
 * Handles two source types:
 * - `url`: returns the URL directly.
 * - `base64`: returns a `data:<media_type>;base64,<data>` URI.
 *
 * Returns `null` when the value is not a valid image block or has no
 * resolvable source.
 */
export function extractImage(value: unknown): string | null {
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
