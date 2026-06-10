/** Size limits that keep huge transcript payloads from freezing the DOM. */

/** Plain-text content above this many chars renders clamped behind "Show all". */
export const MAX_TEXT_CHARS = 50_000;

/**
 * Markdown source above this many chars skips remark parsing entirely (a
 * multi-MB pasted log must never hit the markdown parser) and renders as
 * clamped plain text with an opt-in to parse anyway.
 */
export const MAX_MARKDOWN_CHARS = 100_000;

/** Where to cut clamped text: the last newline before `limit`, if it isn't
 * pathologically early (single-line blobs cut mid-line at the limit). */
export function clampCut(text: string, limit: number): number {
  const nl = text.lastIndexOf('\n', limit);
  return nl > limit / 2 ? nl : limit;
}

/** Human label for the hidden remainder, e.g. "2.4 MB, ~38,000 lines". */
export function clampLabel(text: string): string {
  const bytes = text.length;
  const size =
    bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return `${size}, ~${lines.toLocaleString('en-US')} lines`;
}
