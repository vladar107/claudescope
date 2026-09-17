/**
 * opencode skills — read live from opencode's own config dir, never indexed.
 *
 * opencode looks for skills under `<config>/skills` (current) and the legacy
 * singular `<config>/skill`; it also reads Claude Code's user-level skills
 * dir (`~/.claude/skills`, tagged `shared` here since it is another agent's
 * install) and the cross-agent `~/.agents/skills`.
 *
 * STRICTLY READ-ONLY with respect to opencode's config dir, ~/.claude and
 * ~/.agents — files are only ever read.
 */

import { join } from 'node:path';
import { claudeHome, opencodeConfigDir, sharedSkillsDirBeside } from '../../settings.js';
import type { SkillEntry } from '../types.js';
import { readSkillDirs } from '../skill-md.js';

export function opencodeSkills(): SkillEntry[] {
  return readSkillDirs([
    { dir: join(opencodeConfigDir(), 'skills'), origin: 'user' },
    { dir: join(opencodeConfigDir(), 'skill'), origin: 'user' },
    { dir: join(claudeHome(), 'skills'), origin: 'shared' },
    { dir: sharedSkillsDirBeside(claudeHome()), origin: 'shared' },
  ]);
}
