/**
 * Count of failed tool calls on a canonical row: `tool_result` blocks flagged
 * `is_error`. Stored in the nullable `events.tool_error_count` column — a
 * connector whose source format carries no error signal at all (Junie's
 * "modified: path" result strings, Antigravity's typed result records) emits
 * NULL so "no errors" and "can't know" stay distinguishable in analytics.
 */
export function toolErrorCount(
  blocks: ReadonlyArray<{ type: string; is_error?: boolean }>,
): number {
  return blocks.filter((b) => b.type === 'tool_result' && b.is_error === true).length;
}

/**
 * Per-event cap on {@link toolErrorText}, so a single multi-megabyte failure (a
 * truncated build log, a stack trace with an embedded payload) can't bloat the
 * index. Shared with the Claude Code SQL projection, which derives the same
 * column in DuckDB.
 */
export const MAX_TOOL_ERROR_TEXT = 4000;

/**
 * Bodies of the failed `tool_result` blocks on a canonical row, newline-joined
 * and capped — the searchable half of {@link toolErrorCount}. Stored in
 * `events.tool_error_text` so a literal search finds an error message the
 * assistant never restated in prose. NULL when the row has no failed result.
 */
export function toolErrorText(
  blocks: ReadonlyArray<{ type: string; is_error?: boolean; content?: unknown }>,
): string | null {
  const bodies = blocks
    .filter((b) => b.type === 'tool_result' && b.is_error === true)
    .map((b) => resultText(b.content))
    .filter((t): t is string => t !== null);
  if (bodies.length === 0) return null;
  const capped = bodies.join('\n').slice(0, MAX_TOOL_ERROR_TEXT);
  // Slicing by UTF-16 unit can cut a surrogate pair in half, and DuckDB's JSON
  // reader nulls out every column of a cache line carrying a lone surrogate —
  // losing the whole event, not just its error text. Drop the orphan half.
  return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped;
}

/**
 * A `tool_result.content` as searchable text. It is usually a plain string, but
 * can also be an array of blocks (a tool returning an image beside its message)
 * — only the text items of that form count. Any other shape has no body at all.
 */
function resultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((b): b is { type: string; text: string } =>
      (b as { type?: unknown })?.type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('\n');
}
