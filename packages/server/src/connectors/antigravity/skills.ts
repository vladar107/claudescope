/**
 * Google Antigravity skills — read live across both appDataDirs, never
 * indexed: the desktop app's `<antigravityDir>/skills` and the CLI's
 * `<antigravityHome>/config/skills`.
 *
 * STRICTLY READ-ONLY with respect to ~/.gemini — files are only ever read.
 */

import { join } from 'node:path';
import { antigravityDesktopDir, antigravityHome } from '../../settings.js';
import type { SkillEntry } from '../types.js';
import { readSkillDirs } from '../skill-md.js';

export function antigravitySkills(): SkillEntry[] {
  return readSkillDirs([
    { dir: join(antigravityDesktopDir(), 'skills'), origin: 'user' },
    { dir: join(antigravityHome(), 'config', 'skills'), origin: 'user' },
  ]);
}
