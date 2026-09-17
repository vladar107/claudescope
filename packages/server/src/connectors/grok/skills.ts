/**
 * Grok CLI skills — read live (never indexed) from `~/.grok/skills`.
 *
 * STRICTLY READ-ONLY with respect to ~/.grok — files are only ever read.
 */

import { join } from 'node:path';
import { grokHome } from '../../settings.js';
import { readSkillDirs } from '../skill-md.js';
import type { SkillEntry } from '../types.js';

export function grokSkills(): SkillEntry[] {
  return readSkillDirs([{ dir: join(grokHome(), 'skills'), origin: 'user' }]);
}
