/**
 * opencode subagent definitions — read live from opencode's config dir, never
 * indexed. Two sources, both named the way opencode names them:
 *   - markdown: `<config>/agent/**\/*.md` (and `agents/`), named by the file
 *     stem — a frontmatter `name` is kept only as an alias;
 *   - config: the `agent` object of `opencode.json` / `opencode.jsonc`, named
 *     by its key. A key that matches a markdown agent configures that agent
 *     (filling its description/model); a key alone is listed with the config
 *     file as its path, but only when it carries a `description` or `prompt` —
 *     a bare key only tweaks a built-in agent (`build: { model }`).
 * Primary agents (`mode: primary`, and the `mode/`/`modes/` dirs) and disabled
 * ones (`disable: true`) cannot be spawned and are left out, whichever source
 * says so. Format: https://opencode.ai/docs/agents/.
 *
 * STRICTLY READ-ONLY with respect to opencode's config dir — files are only
 * ever read.
 */

import { join } from 'node:path';
import { opencodeConfigDir } from '../../settings.js';
import { readAgentDirs, type AgentFrontmatter } from '../agent-md.js';
import { readJsonFile } from '../extensions/config-files.js';
import { rec, str } from '../json.js';
import { isoMtime, resolveReal } from '../skill-md.js';
import type { SubagentEntry } from '../types.js';

const CONFIG_FILES = ['opencode.json', 'opencode.jsonc'];

interface ConfigAgent {
  key: string;
  path: string;
  description: string;
  model: string;
  prompt: string;
  excluded: boolean;
}

function configAgents(): ConfigAgent[] {
  const out: ConfigAgent[] = [];
  for (const path of CONFIG_FILES.map((f) => join(opencodeConfigDir(), f))) {
    for (const [key, value] of Object.entries(rec(rec(readJsonFile(path)).agent))) {
      const agent = rec(value);
      out.push({
        key,
        path,
        description: str(agent.description).trim(),
        model: str(agent.model).trim(),
        prompt: str(agent.prompt).trim(),
        excluded: agent.mode === 'primary' || agent.disable === true,
      });
    }
  }
  return out;
}

function configEntry(agent: ConfigAgent): SubagentEntry | null {
  try {
    return {
      name: agent.key,
      aliases: [],
      ...(agent.description ? { description: agent.description } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      origin: 'user',
      path: agent.path,
      realPath: resolveReal(agent.path),
      updatedAt: isoMtime(agent.path),
    };
  } catch {
    return null;
  }
}

export function opencodeSubagents(): SubagentEntry[] {
  const config = configAgents();
  const excluded = new Set(config.filter((a) => a.excluded).map((a) => a.key));
  const include = (fm: AgentFrontmatter, id: string): boolean => {
    if (fm.mode !== 'primary' && fm.disable !== 'true') return true;
    excluded.add(id);
    return false;
  };
  const base = { origin: 'user' as const, recursive: true, nameFromFile: true, include };
  const files = readAgentDirs([
    { ...base, dir: join(opencodeConfigDir(), 'agent') },
    { ...base, dir: join(opencodeConfigDir(), 'agents') },
  ]);

  const out: SubagentEntry[] = [];
  const named = new Set<string>();
  for (const entry of files) {
    if (excluded.has(entry.name) || named.has(entry.name)) continue;
    named.add(entry.name);
    const override = config.find((a) => a.key === entry.name);
    out.push({
      ...entry,
      ...(!entry.description && override?.description ? { description: override.description } : {}),
      ...(!entry.model && override?.model ? { model: override.model } : {}),
    });
  }
  for (const agent of config) {
    if (excluded.has(agent.key) || named.has(agent.key)) continue;
    if (!agent.description && !agent.prompt) continue;
    const entry = configEntry(agent);
    if (!entry) continue;
    named.add(agent.key);
    out.push(entry);
  }
  return out;
}
