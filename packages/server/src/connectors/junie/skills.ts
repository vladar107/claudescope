/**
 * Junie skills — read live (never indexed) from `~/.junie`.
 *
 * Two stores:
 *   - user: `~/.junie/skills/*\/SKILL.md`.
 *   - system: the skills bundled with the NEWEST installed Junie build,
 *     `~/.junie/versions/<build>/skills/` (older builds linger after an
 *     update, so only the highest build number is read).
 *
 * A load shows up as a `toolType: 'Skill'` block in the event stream (mapped
 * to canonical `Skill` in `normalize.ts`), so usage is real for Junie.
 * STRICTLY READ-ONLY with respect to ~/.junie — files are only ever read.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { junieHome } from '../../settings.js';
import { readSkillDirs, type SkillDirSpec } from '../skill-md.js';
import type { SkillEntry } from '../types.js';

/** Build dirs are dotted numbers (`3196.5`); compare them numerically, not lexically. */
function compareBuilds(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The bundled skills dir of the newest installed build, if any. */
function bundledSkillsDir(): SkillDirSpec[] {
  const versionsDir = join(junieHome(), 'versions');
  let builds: string[];
  try {
    builds = readdirSync(versionsDir).filter((name) => /^\d+(\.\d+)*$/.test(name));
  } catch {
    return [];
  }
  const newest = builds.sort(compareBuilds).at(-1);
  return newest ? [{ dir: join(versionsDir, newest, 'skills'), origin: 'system' }] : [];
}

export function junieSkills(): SkillEntry[] {
  return readSkillDirs([{ dir: join(junieHome(), 'skills'), origin: 'user' }, ...bundledSkillsDir()]);
}
