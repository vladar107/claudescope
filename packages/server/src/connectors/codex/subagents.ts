/**
 * Codex subagent definitions — read live (never indexed) from
 * `~/.codex/agents/*.toml`, one agent per file: `name` (else the file stem),
 * `description`, `model`, and `developer_instructions` (not surfaced). A spawn
 * names the agent through `spawn_agent`'s `agent_type`. A malformed file is
 * skipped on its own.
 *
 * STRICTLY READ-ONLY with respect to ~/.codex — files are only ever read.
 */

import { basename, join } from 'node:path';
import { codexHome } from '../../settings.js';
import { filesIn, readTomlFile } from '../extensions/config-files.js';
import { rec, str } from '../json.js';
import { isoMtime, resolveReal } from '../skill-md.js';
import type { SubagentEntry } from '../types.js';

function entryFor(file: string): SubagentEntry | null {
  const parsed = readTomlFile(file);
  if (parsed === undefined) return null;
  const toml = rec(parsed);
  const stem = basename(file, '.toml');
  const name = str(toml.name).trim() || stem;
  const description = str(toml.description).trim();
  const model = str(toml.model).trim();
  try {
    return {
      name,
      aliases: name === stem ? [] : [stem],
      ...(description ? { description } : {}),
      ...(model ? { model } : {}),
      origin: 'user',
      path: file,
      realPath: resolveReal(file),
      updatedAt: isoMtime(file),
    };
  } catch {
    return null; // vanished between read and stat
  }
}

export function codexSubagents(): SubagentEntry[] {
  return filesIn(join(codexHome(), 'agents'), '.toml').flatMap((file) => entryFor(file) ?? []);
}
