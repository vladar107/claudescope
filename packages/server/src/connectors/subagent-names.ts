/**
 * Comma-joined `subagent_type` of the canonical `Task`/`Agent` spawns in a
 * message, in order (empty string when there are none). Stored in the
 * `events.subagent_names` column and shaped exactly like `events.skill_names`:
 * `tool_names` on its own only ever says "Task", and the agent actually
 * spawned lives in the call's input.
 *
 * Only canonical blocks are read — a connector whose native spawn shape names
 * its agent elsewhere either maps it onto `Task.subagent_type` or appends the
 * names itself (pi's batch `subagent` call). There is no dedupe: one spawn is
 * one entry, so a message spawning the same agent twice yields `x,x`. A spawn
 * without a type (Claude Code's implicit general-purpose agent) records
 * nothing, and a name containing a comma is dropped so the CSV stays
 * unambiguous.
 */
export function subagentNamesCsv(
  blocks: ReadonlyArray<{ type: string; name?: string; input?: unknown }>,
): string {
  const names: string[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_use' || (b.name !== 'Task' && b.name !== 'Agent')) continue;
    const type = (b.input as { subagent_type?: unknown } | null | undefined)?.subagent_type;
    if (typeof type === 'string' && type !== '' && !type.includes(',')) names.push(type);
  }
  return names.join(',');
}
