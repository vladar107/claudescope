/**
 * Shared reader for markdown subagent definitions — one `.md` file per agent,
 * YAML frontmatter (`name`, `description`, `model`, format flags) over a
 * prompt body, the layout Claude Code, opencode, Copilot, pi, Junie and
 * Antigravity all use. Connectors say WHICH dirs they scan and how a file is
 * named; this module walks them, parses the frontmatter and resolves
 * symlinks, so definitions are shaped the same for every agent.
 *
 * STRICTLY READ-ONLY. Every read is best-effort: an absent dir or an
 * unreadable file yields nothing, never an error — "no subagents" is the
 * common state.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SkillOrigin, SkillPlugin } from '@claudescope/shared';
import { isoMtime, parseFrontmatterFields, resolveReal } from './skill-md.js';
import type { SubagentEntry } from './types.js';

const FRONTMATTER_KEYS = ['name', 'description', 'model', 'mode', 'disable', 'subagent'] as const;

/** The frontmatter fields subagent readers use, as raw strings (`disable: true` → `'true'`). */
export type AgentFrontmatter = Partial<Record<(typeof FRONTMATTER_KEYS)[number], string>>;

/** One dir a connector scans for subagent definitions, and how its files are named. */
export interface AgentDirSpec {
  dir: string;
  origin: SkillOrigin;
  plugin?: SkillPlugin;
  /** Prefix prepended to every name (Claude Code plugin agents: `plugin:`). */
  namePrefix?: string;
  /** Descend into subdirs (up to four levels). */
  recursive?: boolean;
  /** With `recursive`: subdir segments join the name as `sub:name` (Claude Code plugins). */
  namespaceSubdirs?: boolean;
  /**
   * File suffixes that mark a definition, stripped to get the file's id;
   * default `['.md']`. When two files in one dir share an id, the earlier
   * suffix wins (Copilot: `x.agent.md` over `x.md`).
   */
  suffixes?: string[];
  /** A subdir holding this file is a definition named by the subdir (Antigravity `<name>/agent.md`). */
  dirFile?: string;
  /**
   * The file id is the agent's name and a frontmatter `name` only an alias
   * (opencode names by filename; Copilot's `name` is a display name). By
   * default the frontmatter `name` wins and the id is the alias.
   */
  nameFromFile?: boolean;
  /** Keep only definitions whose frontmatter passes (drops primary-only/disabled agents); `id` as for `nameFromFile`. */
  include?: (fm: AgentFrontmatter, id: string) => boolean;
}

export function parseAgentFrontmatter(raw: string): AgentFrontmatter {
  return parseFrontmatterFields(raw, FRONTMATTER_KEYS);
}

/** Build the entry for the definition at `file`, whose id is `id` under subdir `segments`. */
function entryFor(file: string, id: string, segments: string[], spec: Omit<AgentDirSpec, 'dir'>): SubagentEntry | null {
  let fm: AgentFrontmatter;
  let updatedAt: string;
  try {
    fm = parseAgentFrontmatter(readFileSync(file, 'utf8'));
    updatedAt = isoMtime(file);
  } catch {
    return null; // vanished/unreadable between readdir and read
  }
  if (spec.include && !spec.include(fm, id)) return null;

  const prefix = spec.namePrefix ?? '';
  const ns = spec.namespaceSubdirs ? segments.map((s) => `${s}:`).join('') : '';
  const base = spec.nameFromFile ? id : (fm.name ?? id);
  const other = spec.nameFromFile ? fm.name : id;
  const name = `${prefix}${ns}${base}`;
  const candidates = [other ? `${prefix}${ns}${other}` : '', prefix ? `${ns}${base}` : ''];
  const aliases = [...new Set(candidates)].filter((a) => a !== '' && a !== name);

  return {
    name,
    aliases,
    ...(fm.description ? { description: fm.description } : {}),
    ...(fm.model ? { model: fm.model } : {}),
    origin: spec.origin,
    ...(spec.plugin ? { plugin: spec.plugin } : {}),
    path: file,
    realPath: resolveReal(file),
    updatedAt,
  };
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The id of `fileName` with the first matching suffix stripped, and that suffix's rank; null when none match. */
function idOf(fileName: string, suffixes: string[]): { id: string; rank: number } | null {
  for (let rank = 0; rank < suffixes.length; rank++) {
    const suffix = suffixes[rank] as string;
    if (fileName.length > suffix.length && fileName.endsWith(suffix)) {
      return { id: fileName.slice(0, -suffix.length), rank };
    }
  }
  return null;
}

function walk(dir: string, segments: string[], spec: AgentDirSpec, out: SubagentEntry[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // no such dir — the common case
  }
  const suffixes = spec.suffixes ?? ['.md'];
  const files = new Map<string, { file: string; rank: number }>();
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    if (isDir(path)) {
      const nested = spec.dirFile ? join(path, spec.dirFile) : '';
      if (nested && isFile(nested)) {
        const entry = entryFor(nested, name, segments, spec);
        if (entry) out.push(entry);
      } else if (spec.recursive && segments.length < 4) {
        walk(path, [...segments, name], spec, out);
      }
      continue;
    }
    const match = idOf(name, suffixes);
    if (!match) continue;
    const seen = files.get(match.id);
    if (!seen || match.rank < seen.rank) files.set(match.id, { file: path, rank: match.rank });
  }
  for (const [id, { file }] of files) {
    const entry = entryFor(file, id, segments, spec);
    if (entry) out.push(entry);
  }
}

/** Every definition under `spec.dir`, in name order per dir. `[]` when the dir is absent or empty. */
export function readAgentDir(spec: AgentDirSpec): SubagentEntry[] {
  const out: SubagentEntry[] = [];
  walk(spec.dir, [], spec, out);
  return out;
}

/** Concatenate several dir reads — the usual connector implementation. */
export function readAgentDirs(specs: AgentDirSpec[]): SubagentEntry[] {
  return specs.flatMap((spec) => readAgentDir(spec));
}

/** The one definition at `file` (a plugin manifest's listed agent); null when absent, unreadable or excluded. */
export function readAgentFile(file: string, spec: Omit<AgentDirSpec, 'dir'>): SubagentEntry | null {
  if (!isFile(file)) return null;
  const match = idOf(basename(file), spec.suffixes ?? ['.md']);
  return match ? entryFor(file, match.id, [], spec) : null;
}
