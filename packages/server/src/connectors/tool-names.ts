/**
 * Comma-joined canonical tool names of a message's `tool_use` blocks, in order
 * (empty string when there are none). Stored in the `events.tool_names` column
 * to power the tool-usage breakdown — mirrors how `sessions.models` joins a list
 * into a VARCHAR. Tool names never contain commas, so the join is unambiguous.
 */
export function toolNamesCsv(
  blocks: ReadonlyArray<{ type: string; name?: string }>,
): string {
  return blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => b.name ?? '')
    .filter((n) => n !== '')
    .join(',');
}
