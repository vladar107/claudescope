/**
 * Junie subagent definitions — read live from `~/.junie/agents/*.md`, never
 * indexed. Named by the frontmatter `name`, else the file stem. The
 * cross-agent `~/.agents/` location Junie also documents is not read: its
 * layout for agents is unclear (it holds `skills/` too).
 *
 * STRICTLY READ-ONLY with respect to ~/.junie — files are only ever read.
 */

import { join } from 'node:path';
import { junieHome } from '../../settings.js';
import { readAgentDir } from '../agent-md.js';
import type { SubagentEntry } from '../types.js';

export function junieSubagents(): SubagentEntry[] {
  return readAgentDir({ dir: join(junieHome(), 'agents'), origin: 'user' });
}
