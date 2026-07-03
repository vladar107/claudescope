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
