/**
 * Shared reader for agent skills — directories holding a `SKILL.md` with YAML
 * frontmatter (`name`, `description`), the format every supported agent uses.
 * Connectors only say WHICH dirs they scan and with what origin; this module
 * walks them, parses the frontmatter and resolves symlinks, so the inventory
 * is shaped the same for every agent.
 *
 * STRICTLY READ-ONLY. Every read is best-effort: an absent dir or an
 * unreadable entry yields nothing, never an error — "no skills" is the common
 * state.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SkillOrigin, SkillPlugin } from '@claudescope/shared';
import type { SkillEntry } from './types.js';

export const SKILL_FILE = 'SKILL.md';

/** One dir a connector scans for skills, and how its entries are tagged. */
export interface SkillDirSpec {
  dir: string;
  origin: SkillOrigin;
  plugin?: SkillPlugin;
  /** Prefix prepended to every name (Claude Code plugin skills: `plugin:`). */
  namePrefix?: string;
  /** Descend into subdirs that hold no `SKILL.md` themselves (pi). */
  recursive?: boolean;
  /** Also accept `*.md` files directly in `dir` as single-file skills (pi). */
  rootFiles?: boolean;
  /**
   * With `rootFiles`: accept a root `.md` even without a frontmatter
   * description (plugin `commands/` files are skills named by filename).
   */
  anyRootFile?: boolean;
}

/** The frontmatter fields the inventory shows. */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

/**
 * Hand-parse the leading `---` frontmatter of a SKILL.md. Only `name` and
 * `description` are read; a folded/literal block scalar (`description: >`)
 * gathers its indented continuation lines, since descriptions are routinely
 * multi-line. Returns `{}` when there is no frontmatter block at all.
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return {};

  const fm: SkillFrontmatter = {};
  for (let i = 1; i < end; i++) {
    const m = (lines[i] ?? '').match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1] as string;
    if (key !== 'name' && key !== 'description') continue;
    let value = (m[2] as string).trim();
    if (value === '' || /^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1] ?? '')) {
        parts.push((lines[++i] as string).trim());
      }
      value = parts.join(' ');
    }
    value = value.replace(/^(["'])(.*)\1$/, '$2').trim();
    if (value) fm[key] = value;
  }
  return fm;
}

function isoMtime(path: string): string {
  return new Date(statSync(path).mtimeMs).toISOString();
}

function resolveReal(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Build the entry for one skill whose SKILL.md (or single file) is at `file`. */
function entryFor(
  skillPath: string,
  file: string,
  fallbackName: string,
  spec: SkillDirSpec,
): SkillEntry | null {
  try {
    const fm = parseSkillFrontmatter(readFileSync(file, 'utf8'));
    return {
      name: `${spec.namePrefix ?? ''}${fm.name ?? fallbackName}`,
      dirName: fallbackName,
      ...(fm.description ? { description: fm.description } : {}),
      origin: spec.origin,
      ...(spec.plugin ? { plugin: spec.plugin } : {}),
      path: skillPath,
      realPath: resolveReal(skillPath),
      updatedAt: isoMtime(file),
    };
  } catch {
    return null; // vanished/unreadable between readdir and read
  }
}

/** Whether `path` is (or links to) a directory; false when it can't be stat'ed. */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walk(dir: string, spec: SkillDirSpec, depth: number, out: SkillEntry[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // no such dir — the common case
  }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue; // `.system`, `.git`, `.DS_Store`
    const path = join(dir, name);
    if (isDir(path)) {
      const skillFile = join(path, SKILL_FILE);
      if (statOk(skillFile)) {
        const entry = entryFor(path, skillFile, name, spec);
        if (entry) out.push(entry);
      } else if (spec.recursive && depth < 4) {
        walk(path, spec, depth + 1, out);
      }
    } else if (spec.rootFiles && depth === 0 && name.endsWith('.md')) {
      // pi: a root-level `.md` is a skill only when it carries a description.
      const entry = entryFor(path, path, basename(name, '.md'), spec);
      if (entry && (entry.description || spec.anyRootFile)) out.push(entry);
    }
  }
}

function statOk(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Every skill under `spec.dir`: each direct subdir holding a `SKILL.md` (one
 * level deep unless `recursive`), sorted by entry name. `[]` when the dir is
 * absent or empty.
 */
export function readSkillsDir(spec: SkillDirSpec): SkillEntry[] {
  const out: SkillEntry[] = [];
  walk(spec.dir, spec, 0, out);
  return out;
}

/** One skill whose SKILL.md sits at `file` (a plugin's root-level skill); null when absent. */
export function readSkillFile(file: string, fallbackName: string, spec: Omit<SkillDirSpec, 'dir'>): SkillEntry | null {
  if (!statOk(file)) return null;
  return entryFor(dirname(file), file, fallbackName, { ...spec, dir: dirname(file) });
}

/** Concatenate several dir reads — the usual connector implementation. */
export function readSkillDirs(specs: SkillDirSpec[]): SkillEntry[] {
  return specs.flatMap((spec) => readSkillsDir(spec));
}
