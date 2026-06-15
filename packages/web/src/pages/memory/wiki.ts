/**
 * Helpers for Claude memory `[[wiki-link]]` resolution. Links resolve to in-page
 * anchors only — we never build arbitrary URLs from fact names.
 */

/** A run of plain markdown, or a `[[name]]` wiki-link reference. */
export type WikiSegment = { kind: 'text'; text: string } | { kind: 'link'; name: string };

/** Matches `[[name]]`; the captured name is trimmed by the caller. */
const WIKI_LINK = /\[\[([^\]]+)\]\]/g;

/**
 * Split markdown into alternating text / wiki-link segments. Always returns at
 * least one segment; a body with no links yields a single text segment.
 */
export function splitWikiLinks(markdown: string): WikiSegment[] {
  const segments: WikiSegment[] = [];
  let lastIndex = 0;
  for (const match of markdown.matchAll(WIKI_LINK)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ kind: 'text', text: markdown.slice(lastIndex, start) });
    }
    segments.push({ kind: 'link', name: (match[1] ?? '').trim() });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < markdown.length) {
    segments.push({ kind: 'text', text: markdown.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: 'text', text: markdown }];
}

/** Stable in-page anchor id for a fact title (slugified, namespaced). */
export function anchorId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `memory-${slug}`;
}
