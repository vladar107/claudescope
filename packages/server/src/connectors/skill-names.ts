/**
 * Comma-joined names of the skills a message loads, in order (empty string
 * when there are none). Stored in the `events.skill_names` column and shaped
 * exactly like `events.tool_names`, which on its own only ever says "Skill" —
 * the skill actually invoked lives in the call's input.
 *
 * Two shapes of load are recognised, both deterministic:
 *   - a canonical `Skill` call (`input.skill`) — Claude Code, Grok, opencode
 *     and Junie record the load as its own tool call;
 *   - any other reading call whose input names a `…/skills/<dir>/SKILL.md`
 *     path — Codex, pi, Copilot and Antigravity load a skill by reading that
 *     file (the `SKILL.md` layout is the skill contract itself), so the read is
 *     the load. The name is the skill's DIRECTORY (the last segment before
 *     `SKILL.md`; nested layouts like pi's `skills/group/foo/` yield `foo`),
 *     which is why `data/skills.ts` also joins usage by directory name. A read
 *     inside a plugin cache (`…/plugins/cache/<marketplace>/<plugin>/<version>/…`)
 *     or in a marketplace repo's `plugins/<plugin>/` source is a plugin skill
 *     and is named `plugin:dir`, the way Claude Code's `Skill` tool names it,
 *     so the same skill lines up across agents. Calls
 *     that write, delegate or fetch are skipped: editing a skill is not a load,
 *     and a `Task` prompt that mentions the path is loaded by the child, not
 *     the parent. A block naming the same skill twice counts once.
 *
 * Names never contain a comma, a path separator, a quote, whitespace, a glob
 * character or `$` (an unexpanded shell variable is not a skill), so the CSV
 * stays unambiguous by construction.
 */

/**
 * `skills/<…>/SKILL.md` inside a JSON-encoded input — at the start of a value
 * or after whitespace/quote (a relative `skills/foo/SKILL.md` in a shell
 * command) or after a separator (`\\`-escaped by JSON.stringify, or `/`) —
 * not followed by more of a filename (`SKILL.md.bak` is not a skill). Group 1
 * is everything between `skills/` and `/SKILL.md`; the caller takes its last
 * segment.
 */
const SKILL_FILE_RE = /(?<![^"'\s\\\/])skills(?:\\\\|\/)([^"'\s*?,$]+?)(?:\\\\|\/)SKILL\.md(?![\w.])/g;

/**
 * The plugin a skill path belongs to, from the layout in front of `skills/`:
 * an installed one at `…/plugins/cache/<marketplace>/<plugin>/<version>/…`
 * (the cache layout Claude Code and Codex share), or a plugin under
 * development at `…/plugins/<plugin>/…` inside a marketplace repo. Applied to
 * the text between the last quote/whitespace and the `/skills/` hit; group 1
 * or 2 is the plugin name.
 */
const PLUGIN_PATH_RE =
  /(?:^|\\\\|\/)plugins(?:\\\\|\/)(?:cache(?:\\\\|\/)[^\\\/"'\s]+(?:\\\\|\/)([^\\\/"'\s]+)(?:\\\\|\/)[^\\\/"'\s]+|(?!cache(?:\\\\|\/))([^\\\/"'\s]+))(?:(?:\\\\|\/)[^\\\/"'\s]+)*$/;

/** Canonical tools whose input can name a SKILL.md without loading it. */
const NON_LOADING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'WebFetch', 'WebSearch']);

/** The skill directory a matched `skills/<…>/SKILL.md` path names, or null. */
function dirNameOf(between: string): string | null {
  const segments = between.split(/\\\\|\//).filter((s) => s !== '');
  const last = segments.at(-1);
  if (!last || last === '.' || last === '..') return null;
  return last;
}

export function skillNamesCsv(
  blocks: ReadonlyArray<{ type: string; name?: string; input?: unknown }>,
): string {
  const names: string[] = [];
  for (const b of blocks) {
    if (b.type !== 'tool_use') continue;
    if (b.name === 'Skill') {
      const skill = (b.input as { skill?: unknown } | null | undefined)?.skill;
      if (typeof skill === 'string' && skill !== '' && !skill.includes(',')) names.push(skill);
      continue;
    }
    if (b.input == null || (b.name && NON_LOADING_TOOLS.has(b.name))) continue;
    const seen = new Set<string>();
    const json = JSON.stringify(b.input);
    for (const m of json.matchAll(SKILL_FILE_RE)) {
      const dir = dirNameOf(m[1] as string);
      if (!dir) continue;
      const pathPrefix = (json.slice(0, m.index).match(/[^"'\s]*$/) as RegExpMatchArray)[0].replace(
        /(?:\\\\|\/)$/,
        '',
      );
      const pluginMatch = pathPrefix.match(PLUGIN_PATH_RE);
      const plugin = pluginMatch?.[1] ?? pluginMatch?.[2];
      const name = plugin ? `${plugin}:${dir}` : dir;
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names.join(',');
}
