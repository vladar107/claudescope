/**
 * Utilities for resolving Anthropic-style image content blocks to renderable
 * <img src> strings.
 */

/**
 * Restrict a url-source image to same-origin/relative or `data:image/` URLs.
 * Transcript image blocks are untrusted content (tool results, pasted
 * attachments); a remote URL would otherwise make the browser fetch it
 * (tracking pixel / intranet probe). The CSP already blocks this at the
 * network layer — this closes it at the source so no request is even
 * attempted. Mirrors the markdown `urlTransform` in Markdown.tsx.
 */
function safeImageUrl(url: string): string | null {
  if (/^data:image\//i.test(url)) return url; // inlined image — safe
  if (/^\/\//.test(url) || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null; // protocol-relative or schemed → remote
  return url; // relative / same-origin path
}

/**
 * Pull a renderable `<img src>` string out of an Anthropic-style image block.
 *
 * Handles two source types:
 * - `url`: returns the URL if it is a `data:image/` or same-origin URL
 *   (remote/schemed URLs are rejected — see {@link safeImageUrl}).
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
  if (source.type === 'url' && source.url) return safeImageUrl(source.url);
  if (source.type === 'base64' && source.data && source.media_type) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return null;
}
