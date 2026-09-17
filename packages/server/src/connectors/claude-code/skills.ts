/**
 * Claude Code skills — read live (never indexed) from `~/.claude`.
 *
 * Two stores:
 *   - user: `~/.claude/skills/*\/SKILL.md`.
 *   - plugin: every skill an installed plugin ships (default `skills/`, the
 *     manifest's `skills` paths, `commands/*.md`, or a root `SKILL.md` — see
 *     `connectors/plugin-skills.ts`), per `~/.claude/plugins/installed_plugins.json`
 *     (schema version 2 — `{ plugins: { "<name>@<marketplace>": [{ installPath,
 *     version, ... }] } }`). Claude Code invokes a plugin skill as
 *     `plugin:skill`, and that is what `events.skill_names` stores, so entries
 *     carry a `${name}:` name prefix to match.
 *
 * STRICTLY READ-ONLY with respect to ~/.claude — files are only ever read.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SkillPlugin } from '@claudescope/shared';
import { claudeHome, claudePluginsDir } from '../../settings.js';
import { readPluginSkills } from '../plugin-skills.js';
import { readSkillDirs } from '../skill-md.js';
import type { SkillEntry } from '../types.js';

/** One install entry under a `installed_plugins.json` plugin key. */
interface PluginInstall {
  scope?: string;
  installPath?: string;
  version?: string;
}

interface InstalledPluginsManifest {
  version?: number;
  plugins?: Record<string, PluginInstall[]>;
}

/**
 * Every installed plugin's skills, tagged with the plugin identity. `[]` when
 * the manifest is absent, unparsable, or has no installs — never throws (a
 * missing/corrupt manifest is the common case for most users). An
 * `installPath` is followed wherever it points: the manifest is written by the
 * user's own Claude Code under `~/.claude`, and the read is bounded to skill
 * frontmatter inside that install.
 */
function pluginSkills(): SkillEntry[] {
  const manifestPath = join(claudePluginsDir(), 'installed_plugins.json');
  let plugins: Record<string, PluginInstall[]>;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as InstalledPluginsManifest | null;
    plugins = manifest?.plugins ?? {};
    if (typeof plugins !== 'object' || plugins === null) return [];
  } catch {
    return [];
  }

  const out: SkillEntry[] = [];
  for (const [key, installs] of Object.entries(plugins)) {
    const [name, marketplace] = key.split('@');
    if (!name || !Array.isArray(installs)) continue;
    for (const install of installs) {
      // A relative path would resolve against the daemon's cwd, not ~/.claude.
      if (typeof install?.installPath !== 'string' || !isAbsolute(install.installPath)) continue;
      const plugin: SkillPlugin = {
        name,
        ...(marketplace ? { marketplace } : {}),
        ...(install.version ? { version: install.version } : {}),
      };
      out.push(...readPluginSkills(install.installPath, plugin, `${name}:`));
    }
  }
  return out;
}

/** User skills first, then every installed plugin's skills. */
export function claudeCodeSkills(): SkillEntry[] {
  return [...readSkillDirs([{ dir: join(claudeHome(), 'skills'), origin: 'user' }]), ...pluginSkills()];
}
