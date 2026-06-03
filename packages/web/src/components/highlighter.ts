/**
 * Lazy, shared Shiki highlighter. Loading the full grammar/theme set is heavy,
 * so we create a single highlighter instance on first use and reuse it. A small
 * curated language set keeps the bundle reasonable; unknown languages fall back
 * to plaintext. All failures are swallowed so the caller can render plain text.
 */

import type { Highlighter } from 'shiki';

/** Languages we ship grammars for. Anything else renders as plaintext. */
const LANGS = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'bash',
  'shell',
  'python',
  'sql',
  'html',
  'css',
  'yaml',
  'markdown',
  'diff',
  'rust',
  'go',
  'java',
  'toml',
] as const;

const THEME = 'github-dark';

let highlighterPromise: Promise<Highlighter | null> | null = null;

/** Get (or lazily create) the shared highlighter. Resolves null on failure. */
export function getHighlighter(): Promise<Highlighter | null> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki')
      .then(({ createHighlighter }) =>
        createHighlighter({ themes: [THEME], langs: [...LANGS] }),
      )
      .catch(() => null);
  }
  return highlighterPromise;
}

/** Normalize a fenced-code language hint to one of our supported grammars. */
export function normalizeLang(lang: string | undefined): string {
  if (!lang) return 'text';
  const l = lang.toLowerCase();
  const alias: Record<string, string> = {
    ts: 'typescript',
    js: 'javascript',
    sh: 'bash',
    zsh: 'bash',
    shell: 'bash',
    py: 'python',
    yml: 'yaml',
    md: 'markdown',
    rs: 'rust',
    golang: 'go',
  };
  const resolved = alias[l] ?? l;
  return (LANGS as readonly string[]).includes(resolved) ? resolved : 'text';
}

export { THEME as SHIKI_THEME };
