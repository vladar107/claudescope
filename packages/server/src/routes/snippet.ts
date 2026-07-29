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

/**
 * Non-overlapping `[start, end)` spans of the window matched by any term,
 * merged and in order. Computed on the RAW window, case-insensitively.
 *
 * This is why marking is a single pass. The previous implementation escaped the
 * window and then ran one regex replace per term over the *result*, so a term
 * could match markup an earlier term had just inserted: searching `book mark`
 * produced `the <<mark>mark</mark>>book</<mark>mark</mark>><mark>mark</mark> is
 * here`. Collecting spans first means `<mark>` is never re-scanned, and it drops
 * the need to regex-escape user input at all.
 */
function matchSpans(window: string, terms: string[]): [number, number][] {
  const haystack = window.toLowerCase();
  const spans: [number, number][] = [];
  for (const term of terms) {
    if (!term) continue;
    const needle = term.toLowerCase();
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
      spans.push([i, i + needle.length]);
    }
  }
  // Sort by start (longest first on a tie) so the merge below is a single sweep.
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of spans) {
    const last = merged[merged.length - 1];
    // Overlapping or touching spans become one <mark> instead of nesting.
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
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

  // Escape and wrap in one pass over the raw window, so no <mark> we emit can be
  // matched by a later term. Only the two literal tag strings are unescaped —
  // everything from the transcript goes through escapeHtml.
  let out = '';
  let cursor = 0;
  for (const [start, end] of matchSpans(window, terms)) {
    out += escapeHtml(window.slice(cursor, start));
    out += `<mark>${escapeHtml(window.slice(start, end))}</mark>`;
    cursor = end;
  }
  return out + escapeHtml(window.slice(cursor));
}
