/**
 * GitHub Copilot CLI skills — read live from `~/.copilot/skills`, never
 * indexed.
 *
 * STRICTLY READ-ONLY with respect to ~/.copilot — files are only ever read.
 */

import { join } from 'node:path';
import { copilotHome } from '../../settings.js';
import type { SkillEntry } from '../types.js';
import { readSkillDirs } from '../skill-md.js';

export function copilotSkills(): SkillEntry[] {
  return readSkillDirs([{ dir: join(copilotHome(), 'skills'), origin: 'user' }]);
}
