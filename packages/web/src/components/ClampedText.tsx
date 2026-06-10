import { useState } from 'react';
import { MAX_TEXT_CHARS, clampCut, clampLabel } from './limits.js';

export interface ClampedTextProps {
  text: string;
  /** Chars rendered before the "Show all" affordance. */
  limit?: number;
  /** Force full rendering (e.g. an in-session search match is in the tail). */
  forceExpand?: boolean;
  /** className for the wrapping <pre> (e.g. `tv-pre`, `tv-code-plain`). */
  className?: string;
  /** Wrap the text in a <code> element (matches the code-style <pre> sinks). */
  code?: boolean;
}

/**
 * Plain-text <pre> that clamps huge payloads: content over `limit` renders only
 * its head (cut at a line boundary) plus a "Show all" button, so a multi-MB
 * tool output never lands in the DOM unasked. Small text renders exactly like
 * the plain <pre>/<code> it replaces.
 */
export function ClampedText({
  text,
  limit = MAX_TEXT_CHARS,
  forceExpand = false,
  className,
  code = false,
}: ClampedTextProps) {
  const [userExpanded, setUserExpanded] = useState(false);
  const expanded = userExpanded || forceExpand || text.length <= limit;
  const shown = expanded ? text : text.slice(0, clampCut(text, limit));

  return (
    <>
      <pre className={className}>{code ? <code>{shown}</code> : shown}</pre>
      {expanded ? null : (
        <button
          type="button"
          className="tv-linkbtn tv-clamp-more"
          onClick={() => setUserExpanded(true)}
        >
          Show all ({clampLabel(text)})
        </button>
      )}
    </>
  );
}
