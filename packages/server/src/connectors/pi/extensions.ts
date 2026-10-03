/**
 * pi extensions (plugins) — read live from `~/.pi/agent`, never indexed.
 *   - packages: the `packages` array of `settings.json` (string or `{ source }`)
 *   - extension files: `extensions/*.{ts,js}` and `extensions/<dir>/index.{ts,js}`
 * No MCP (pi has none built in) and no hooks (code inside extensions).
 * Formats: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md
 * and …/docs/extensions.md.
 *
 * STRICTLY READ-ONLY with respect to ~/.pi — files are only ever read.
 */

import { existsSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { piHome } from '../../settings.js';
import { rec } from '../json.js';
import type { PluginEntry } from '../types.js';
import { filesIn, readJsonFile, subdirsOf } from '../extensions/config-files.js';
import { sanitizeSource } from '../extensions/redact.js';
import { contractHome } from '../../util/paths.js';

export function piPlugins(): PluginEntry[] {
  const home = piHome();
  const out: PluginEntry[] = [];

  const settingsPath = join(home, 'settings.json');
  const packages = rec(readJsonFile(settingsPath)).packages;
  if (Array.isArray(packages)) {
    for (const p of packages) {
      const source = typeof p === 'string' ? p : rec(p).source;
      if (typeof source !== 'string') continue;
      out.push({ name: sanitizeSource(isAbsolute(source) ? contractHome(source) : source), kind: 'package', sourcePath: settingsPath });
    }
  }

  const extDir = join(home, 'extensions');
  for (const ext of ['.ts', '.js']) {
    for (const file of filesIn(extDir, ext)) {
      out.push({ name: basename(file, extname(file)), kind: 'file', sourcePath: file });
    }
  }
  for (const dir of subdirsOf(extDir)) {
    const index = ['index.ts', 'index.js'].map((f) => join(extDir, dir, f)).find((f) => existsSync(f));
    if (index) out.push({ name: dir, kind: 'file', sourcePath: index });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
