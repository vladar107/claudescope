/**
 * GitHub Copilot CLI custom agents — read live from `~/.copilot/agents`, never
 * indexed. A definition is `<id>.agent.md` (or plain `<id>.md`); the id is
 * what a `task` spawn records as `agent_type`, while the frontmatter `name` is
 * only a display name, kept as an alias. When both `<id>.agent.md` and
 * `<id>.md` exist, the `.agent.md` file is the definition.
 *
 * STRICTLY READ-ONLY with respect to ~/.copilot — files are only ever read.
 */

import { join } from 'node:path';
import { copilotHome } from '../../settings.js';
import { readAgentDir } from '../agent-md.js';
import type { SubagentEntry } from '../types.js';

export function copilotSubagents(): SubagentEntry[] {
  return readAgentDir({
    dir: join(copilotHome(), 'agents'),
    origin: 'user',
    suffixes: ['.agent.md', '.md'],
    nameFromFile: true,
  });
}
