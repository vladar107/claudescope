/**
 * pi subagent definitions — read live from `~/.pi/agent/agents/*.md` (the
 * layout of pi's subagent example extension), never indexed. Named by the
 * frontmatter `name`, else the file stem.
 *
 * STRICTLY READ-ONLY with respect to ~/.pi — files are only ever read.
 */

import { join } from 'node:path';
import { piHome } from '../../settings.js';
import { readAgentDir } from '../agent-md.js';
import type { SubagentEntry } from '../types.js';

export function piSubagents(): SubagentEntry[] {
  return readAgentDir({ dir: join(piHome(), 'agents'), origin: 'user' });
}
