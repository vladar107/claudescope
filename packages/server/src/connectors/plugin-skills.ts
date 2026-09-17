/**
 * Skills shipped by an installed plugin, for every agent that uses the
 * `.claude-plugin/plugin.json` layout (Claude Code, and Codex's plugin cache,
 * which also carries a `.codex-plugin/plugin.json`). A plugin's skills live in
 * up to four places, all relative to the plugin root:
 *   - the default `skills/` dir, always scanned;
 *   - the manifest `skills` field (string or array, `./`-relative, `.` = root),
 *     scanned in addition — revdiff keeps its skill under
 *     `./.claude-plugin/skills/`;
 *   - flat `commands/*.md` files (or the manifest `commands` paths, which
 *     replace the default), each a skill named by its filename;
 *   - a single `SKILL.md` at the root when nothing else yields a skill.
 * Everything is best-effort and STRICTLY READ-ONLY: a missing or malformed
 * manifest falls back to the defaults, and a path that escapes the plugin root
 * is ignored.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { SkillPlugin } from '@claudescope/shared';
import { readSkillDirs, readSkillFile, SKILL_FILE, type SkillDirSpec } from './skill-md.js';
import type { SkillEntry } from './types.js';

const MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];

interface Manifest {
  skills?: unknown;
  commands?: unknown;
}

/** The manifest `skills`/`commands` paths, resolved under `root`; escapes dropped. */
function manifestPaths(root: string, value: unknown): string[] {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || v === '' || isAbsolute(v)) continue;
    const abs = resolve(root, v);
    const rel = relative(root, abs);
    if (rel.startsWith('..')) continue;
    out.push(abs);
  }
  return out;
}

function readManifests(root: string): Manifest[] {
  const out: Manifest[] = [];
  for (const name of MANIFESTS) {
    try {
      const m = JSON.parse(readFileSync(join(root, name), 'utf8')) as Manifest | null;
      if (m && typeof m === 'object') out.push(m);
    } catch {
      // absent or malformed — the defaults below still apply
    }
  }
  return out;
}

/**
 * Every skill an installed plugin at `root` ships. `namePrefix` is how the
 * agent namespaces plugin skills when it invokes them (Claude Code:
 * `plugin:skill`); leave it out for agents that don't.
 */
export function readPluginSkills(root: string, plugin: SkillPlugin, namePrefix?: string): SkillEntry[] {
  const manifests = readManifests(root);
  const base = { origin: 'plugin' as const, plugin, ...(namePrefix ? { namePrefix } : {}) };

  const skillDirs = new Set([join(root, 'skills')]);
  for (const m of manifests) for (const d of manifestPaths(root, m.skills)) skillDirs.add(d);

  const declaredCommands = manifests.flatMap((m) => manifestPaths(root, m.commands));
  const commandDirs = declaredCommands.length > 0 ? declaredCommands : [join(root, 'commands')];

  const specs: SkillDirSpec[] = [
    ...[...skillDirs].map((dir) => ({ ...base, dir })),
    ...commandDirs.map((dir) => ({ ...base, dir, rootFiles: true, anyRootFile: true })),
  ];
  const entries = readSkillDirs(specs);
  if (entries.length > 0) return entries;

  const single = readSkillFile(join(root, SKILL_FILE), plugin.name, base);
  return single ? [single] : [];
}
