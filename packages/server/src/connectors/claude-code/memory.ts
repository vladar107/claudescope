/**
 * Claude Code memory — read live (never indexed) from `~/.claude`.
 *
 * Two stores:
 *   - global: `~/.claude/CLAUDE.md`, the user-authored global instruction file,
 *     surfaced as a single `document` source.
 *   - per-project: `~/.claude/projects/<slug>/memory/*.md`, the agent-distilled
 *     typed facts. Each fact is a markdown file with a leading `---` YAML
 *     frontmatter block; the `MEMORY.md` index file is redundant and skipped.
 *
 * Claude keys a memory dir by the **git repo root**, so one dir may hold facts
 * learned across several worktrees/cwds. We therefore do NOT attribute facts to
 * a cwd here — {@link projectMemory} returns every dir tagged with its slug, and
 * the route attributes each fact to a project via its `originSessionId`.
 *
 * STRICTLY READ-ONLY with respect to ~/.claude, and only ever reads from the
 * agent home dir — never from the user's project directories.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemorySource } from '@claudescope/shared';
import type { AgentMemoryDir } from '../types.js';
import { CLAUDE_HOME, CLAUDE_PROJECTS_DIR } from '../../config.js';
import { contractHome } from '../../util/paths.js';

/**
 * Dash-encode a `cwd` to the directory slug Claude Code uses under
 * `~/.claude/projects/`. Every non-alphanumeric character maps to a single `-`,
 * per-character (NOT run-collapsed): `/Users/x/src/y` → `-Users-x-src-y`. This
 * intentionally differs from the Claudescope project-id slug, which collapses
 * runs and trims edges (see `data/project-id.ts`). Exported so the memory route
 * can map a project cwd to its memory dir slug for attribution fallback.
 */
export function memorySlugForCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Parsed frontmatter fields we care about, normalized across both layouts. */
interface Frontmatter {
  name?: string;
  description?: string;
  type?: string;
  originSessionId?: string;
}

/**
 * Hand-parse the leading `---` YAML frontmatter of a fact file, returning the
 * normalized fields plus the markdown body that follows. Tolerates BOTH
 * layouts: (A) nested — top-level `name`/`description` plus a `metadata:` block
 * with indented `node_type`/`type`/`originSessionId`; (B) flat/legacy —
 * `name`/`description`/`type`/`originSessionId` all top-level (oldest files lack
 * `originSessionId`). A stray `scope` key is tolerated and ignored.
 */
function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') return { fm: {}, body: raw };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { fm: {}, body: raw };

  const fm: Frontmatter = {};
  // Depth-agnostic key match: the nested `metadata:` block holds
  // `type`/`originSessionId`, so matching keys regardless of indent captures both
  // the nested and flat layouts.
  const assign = (key: string, value: string): void => {
    const v = value.trim().replace(/^["']|["']$/g, '');
    if (!v) return;
    switch (key) {
      case 'name':
        fm.name = v;
        break;
      case 'description':
        fm.description = v;
        break;
      case 'type':
        fm.type = v;
        break;
      case 'originSessionId':
        fm.originSessionId = v;
        break;
      default:
        break;
    }
  };

  for (let i = 1; i < end; i++) {
    const m = (lines[i] ?? '').match(/^\s*([A-Za-z_][\w]*)\s*:\s*(.*)$/);
    if (m) assign(m[1] as string, m[2] as string);
  }

  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { fm, body };
}

/** Unique `[[name]]` wiki-link targets referenced in a fact body, in order. */
function relatedNames(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = (m[1] as string).trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * The user-authored global instruction file (`~/.claude/CLAUDE.md`), as a single
 * `document` source. `[]` when absent, empty, or unreadable.
 */
export function globalMemory(): MemorySource[] {
  const path = join(CLAUDE_HOME, 'CLAUDE.md');
  try {
    const markdown = readFileSync(path, 'utf8');
    if (!markdown.trim()) return [];
    return [
      {
        provenance: 'user-authored',
        kind: 'document',
        title: 'CLAUDE.md (global)',
        markdown,
        sourcePath: contractHome(path),
        updatedAt: new Date(statSync(path).mtimeMs).toISOString(),
      },
    ];
  } catch {
    return [];
  }
}

/** Parse one fact file into a MemorySource, or `null` if it's not a fact file. */
function readFact(dir: string, fileName: string): MemorySource | null {
  if (!fileName.endsWith('.md') || fileName === 'MEMORY.md') return null;
  const path = join(dir, fileName);
  try {
    const raw = readFileSync(path, 'utf8');
    const updatedAt = new Date(statSync(path).mtimeMs).toISOString();
    const { fm, body } = parseFrontmatter(raw);
    return {
      provenance: 'agent-authored',
      kind: 'fact',
      title: fm.name ?? fileName.replace(/\.md$/, ''),
      ...(fm.description ? { description: fm.description } : {}),
      ...(fm.type ? { category: fm.type } : {}),
      markdown: body,
      sourcePath: contractHome(path),
      updatedAt,
      ...(fm.originSessionId ? { originSessionId: fm.originSessionId } : {}),
      relatedNames: relatedNames(body),
    };
  } catch {
    return null; // vanished/unreadable between readdir and read
  }
}

/**
 * Every `~/.claude/projects/<slug>/memory/` directory that holds at least one
 * fact, tagged with its `slug`. The route attributes each fact to a project via
 * `originSessionId` (slug as the fallback). `[]` when none exist.
 */
export function projectMemory(): AgentMemoryDir[] {
  let projectDirs: import('node:fs').Dirent[];
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: AgentMemoryDir[] = [];
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const memDir = join(CLAUDE_PROJECTS_DIR, projectDir.name, 'memory');

    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(memDir, { withFileTypes: true });
    } catch {
      continue; // no memory/ dir for this project
    }

    const facts: MemorySource[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fact = readFact(memDir, entry.name);
      if (fact) facts.push(fact);
    }
    if (facts.length > 0) dirs.push({ slug: projectDir.name, facts });
  }
  return dirs;
}
