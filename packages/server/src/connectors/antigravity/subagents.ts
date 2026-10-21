/**
 * Google Antigravity subagent definitions — read live from
 * `<antigravityHome>/config/agents` (`~/.gemini/config/agents`), never
 * indexed. A definition is either `<name>.md` or `<name>/agent.md`, named by
 * the frontmatter `name`, else the file or dir name. One marked
 * `subagent: false` is a primary agent only and is left out.
 *
 * STRICTLY READ-ONLY with respect to ~/.gemini — files are only ever read.
 */

import { join } from 'node:path';
import { antigravityHome } from '../../settings.js';
import { readAgentDir } from '../agent-md.js';
import type { SubagentEntry } from '../types.js';

export function antigravitySubagents(): SubagentEntry[] {
  return readAgentDir({
    dir: join(antigravityHome(), 'config', 'agents'),
    origin: 'user',
    dirFile: 'agent.md',
    include: (fm) => fm.subagent !== 'false',
  });
}
