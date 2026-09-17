/**
 * pi skills — read live from `~/.pi/agent/skills` and the shared cross-agent
 * `~/.agents/skills`, never indexed.
 *
 * Both dirs are scanned recursively: pi does not require a `SKILL.md` to sit
 * exactly one level deep. Its own skills dir additionally accepts a
 * root-level `.md` file carrying a description as a single-file skill.
 *
 * STRICTLY READ-ONLY with respect to ~/.pi and ~/.agents — files are only
 * ever read.
 */

import { dirname, join } from 'node:path';
import { piHome, sharedSkillsDirBeside } from '../../settings.js';
import type { SkillEntry } from '../types.js';
import { readSkillDirs } from '../skill-md.js';

export function piSkills(): SkillEntry[] {
  return readSkillDirs([
    { dir: join(piHome(), 'skills'), origin: 'user', recursive: true, rootFiles: true },
    { dir: sharedSkillsDirBeside(dirname(piHome())), origin: 'shared', recursive: true },
  ]);
}
