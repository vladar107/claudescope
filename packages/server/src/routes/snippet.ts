/**
 * Search-hit snippets: a text window around the first matched term, rendered
 * either as HTML (matches wrapped in `<mark>`, rest escaped — the web UI) or
 * as plain text (agent/CLI consumers; no escaping, no markup).
 */

import type { SnippetFormat } from '@claudescope/shared';

/** Max characters of context around the first match in a snippet. */
const SNIPPET_RADIUS = 120;

/** Escape HTML special chars so snippets are safe to render. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a snippet: find the first occurrence of any query term in the text and
 * return a window around it. `html` wraps matching terms in `<mark>`; `plain`
 * returns the raw window (ellipses only).
 */
export function makeSnippet(text: string, terms: string[], format: SnippetFormat = 'html'): string {
  const lower = text.toLowerCase();
  let firstIdx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (firstIdx === -1 || i < firstIdx)) firstIdx = i;
  }
  const start = firstIdx === -1 ? 0 : Math.max(0, firstIdx - SNIPPET_RADIUS);
  const end = Math.min(text.length, (firstIdx === -1 ? 0 : firstIdx) + SNIPPET_RADIUS * 2);
  let window = text.slice(start, end);
  if (start > 0) window = '…' + window;
  if (end < text.length) window = window + '…';

  if (format === 'plain') return window;

  let escaped = escapeHtml(window);
  for (const t of terms) {
    if (!t) continue;
    escaped = escaped.replace(new RegExp(`(${escapeRegExp(escapeHtml(t))})`, 'gi'), '<mark>$1</mark>');
  }
  return escaped;
}
