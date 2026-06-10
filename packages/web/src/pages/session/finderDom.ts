/**
 * DOM layer for the in-session finder: highlight the active match inside a
 * single (already-revealed) block using the CSS Custom Highlight API, and
 * scroll it into view. Scoped to one block, so it stays cheap regardless of how
 * many matches exist across the transcript.
 */

import type { FinderMatch } from './search.js';

// The CSS Custom Highlight API isn't in every TS lib; access it defensively.
interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
function registry(): HighlightRegistry | null {
  const reg = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Ctor = (globalThis as unknown as { Highlight?: unknown }).Highlight;
  return reg && typeof Ctor === 'function' ? reg : null;
}
function makeHighlight(ranges: Range[]): unknown {
  const Ctor = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  return new Ctor(...ranges);
}

/** Every (case-insensitive) occurrence of `query` within `root`, in order. */
function collectRanges(root: HTMLElement, query: string): Range[] {
  const q = query.trim().toLowerCase();
  const ranges: Range[] = [];
  if (!q) return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue ?? '').toLowerCase();
    let from = 0;
    let idx = text.indexOf(q, from);
    while (idx !== -1) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + q.length);
      ranges.push(range);
      from = idx + q.length;
      idx = text.indexOf(q, from);
    }
  }
  return ranges;
}

/** Remove all finder highlights. */
export function clearHighlights(): void {
  const reg = registry();
  if (!reg) return;
  reg.delete('cs-find');
  reg.delete('cs-find-active');
}

/**
 * Highlight the active match within its block and scroll it into view. Tints
 * all occurrences in that block, emphasizing the active one. Best-effort: any
 * DOM/Range error is swallowed so the finder can never crash the page.
 *
 * Returns true once the match was found and highlighted, so callers can stop
 * retrying (the block may not be in the DOM yet under progressive mounting).
 */
export function highlightMatchInBlock(
  container: HTMLElement,
  match: FinderMatch,
  query: string,
): boolean {
  try {
    const el = container.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(match.blockId)}"]`,
    );
    if (!el) return false;
    const ranges = collectRanges(el, query);
    if (ranges.length === 0) return false;
    const active = ranges[Math.min(match.occurrenceInBlock, ranges.length - 1)]!;
    const reg = registry();
    if (reg) {
      reg.set('cs-find', makeHighlight(ranges));
      reg.set('cs-find-active', makeHighlight([active]));
    }
    active.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  } catch {
    /* never let the finder crash the reader */
    return false;
  }
}
