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
 * A `media_type` we will put in a `data:` URI. Transcript content is untrusted,
 * and the `url` branch above carefully rejects non-image schemes while the base64
 * branch used to interpolate `media_type` verbatim — so a poisoned block could
 * produce `data:text/html;base64,…`. Inert in the `<img src>` positions both
 * callers use (and blocked by the CSP), but the asymmetry is the kind that turns
 * into a real hole the moment a third caller appears. The server-side inliner has
 * had an equivalent allowlist all along (`connectors/safe-image.ts`).
 *
 * Any `image/*` subtype is accepted rather than a fixed list, so legitimate
 * formats aren't dropped; SVG cannot execute script when loaded via `<img>`.
 */
function isImageMediaType(mediaType: string): boolean {
  return /^image\/[a-z0-9][a-z0-9.+-]*$/i.test(mediaType);
}

/**
 * Pull a renderable `<img src>` string out of an Anthropic-style image block.
 *
 * Handles two source types:
 * - `url`: returns the URL if it is a `data:image/` or same-origin URL
 *   (remote/schemed URLs are rejected — see {@link safeImageUrl}).
 * - `base64`: returns a `data:<media_type>;base64,<data>` URI, but only for an
 *   `image/*` media type (see {@link isImageMediaType}).
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
    if (!isImageMediaType(source.media_type)) return null;
    return `data:${source.media_type};base64,${source.data}`;
  }
  return null;
}
