/**
 * Codex skills — read live (never indexed) from `~/.codex` and the shared dir.
 *
 * Four stores:
 *   - user: `~/.codex/skills/*\/SKILL.md`.
 *   - system: `~/.codex/skills/.system/` — the skills bundled with Codex (named
 *     explicitly: the shared walker skips dot-entries).
 *   - shared: the cross-agent `~/.agents/skills`, located beside `~/.codex`.
 *   - plugin: `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` — the
 *     newest version dir of every cached plugin, read with the shared plugin
 *     reader (Codex plugins carry the same manifest layout as Claude Code's),
 *     named `plugin:skill` like Claude Code's so one skill lines up across
 *     agents. Codex keeps no readable install registry (`config.toml` lists
 *     only some plugins), so the cache itself is the inventory.
 *
 * STRICTLY READ-ONLY — files are only ever read.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillPlugin } from '@claudescope/shared';
import { codexHome, sharedSkillsDirBeside } from '../../settings.js';
import { readPluginSkills } from '../plugin-skills.js';
import { readSkillDirs } from '../skill-md.js';
import type { SkillEntry } from '../types.js';

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** The version dir touched most recently — what an update leaves in use. */
function newestVersionDir(pluginDir: string): string | undefined {
  let best: { name: string; mtime: number } | undefined;
  for (const name of subdirs(pluginDir)) {
    const mtime = statSync(join(pluginDir, name)).mtimeMs;
    if (!best || mtime > best.mtime) best = { name, mtime };
  }
  return best?.name;
}

function pluginSkills(): SkillEntry[] {
  const cache = join(codexHome(), 'plugins', 'cache');
  const out: SkillEntry[] = [];
  for (const marketplace of subdirs(cache)) {
    for (const name of subdirs(join(cache, marketplace))) {
      const pluginDir = join(cache, marketplace, name);
      const version = newestVersionDir(pluginDir);
      if (!version) continue;
      const plugin: SkillPlugin = { name, marketplace, version };
      out.push(...readPluginSkills(join(pluginDir, version), plugin, `${name}:`));
    }
  }
  return out;
}

export function codexSkills(): SkillEntry[] {
  return [
    ...readSkillDirs([
      { dir: join(codexHome(), 'skills'), origin: 'user' },
      { dir: join(codexHome(), 'skills', '.system'), origin: 'system' },
      { dir: sharedSkillsDirBeside(codexHome()), origin: 'shared' },
    ]),
    ...pluginSkills(),
  ];
}
