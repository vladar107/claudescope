/**
 * Comma-joined `skill` argument of a message's canonical `Skill` tool calls, in
 * order (empty string when there are none). Stored in the `events.skill_names`
 * column and shaped exactly like `events.tool_names`, which on its own only ever
 * says "Skill" — the skill actually invoked lives in the call's input. Skill
 * names never contain commas, so the join is unambiguous.
 */
export function skillNamesCsv(
  blocks: ReadonlyArray<{ type: string; name?: string; input?: unknown }>,
): string {
  return blocks
    .filter((b) => b.type === 'tool_use' && b.name === 'Skill')
    .map((b) => (b.input as { skill?: unknown } | null | undefined)?.skill)
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .join(',');
}
