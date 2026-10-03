/**
 * Best-effort, STRICTLY READ-ONLY loaders for agent config files. A missing,
 * unreadable, or malformed file yields `undefined` — an absent config is a
 * normal state, never an error. Parse errors are swallowed whole: their
 * messages can quote file content, and some of these files (`~/.claude.json`)
 * hold credentials.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

/**
 * JSON with `//` and `/* *\/` comments and trailing commas removed (JSONC, as
 * opencode writes it). String-aware, so `"https://…"` survives.
 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return dropTrailingCommas(out);
}

/** Removes a `,` that is followed only by whitespace and `}`/`]` — outside strings. */
function dropTrailingCommas(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === ',') {
      let k = i + 1;
      while (k < text.length && /\s/.test(text[k]!)) k++;
      if (text[k] !== '}' && text[k] !== ']') out += c;
    } else {
      out += c;
    }
  }
  return out;
}

/** A JSON (or JSONC) file's parsed value, or `undefined`. */
export function readJsonFile(path: string): unknown {
  try {
    const raw = readFileSync(path, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      return JSON.parse(stripJsonc(raw));
    }
  } catch {
    return undefined;
  }
}

/** A TOML file's parsed value, or `undefined`. */
export function readTomlFile(path: string): unknown {
  try {
    return parseToml(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Absolute paths of the files in `dir` whose names end with `ext`, sorted; `[]` when absent. */
export function filesIn(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(ext) && !d.name.startsWith('.'))
      .map((d) => join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

/** Names of the visible subdirectories of `dir`, sorted; `[]` when absent. */
export function subdirsOf(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
