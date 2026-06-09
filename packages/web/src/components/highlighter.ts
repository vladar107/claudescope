/**
 * Lazy, shared Shiki highlighter. Loading the full grammar/theme set is heavy,
 * so we create a single highlighter instance on first use and reuse it. A small
 * curated language set keeps the bundle reasonable; unknown languages fall back
 * to plaintext. All failures are swallowed so the caller can render plain text.
 */

import type { BundledLanguage, Highlighter, SpecialLanguage } from 'shiki';

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

/** Resolved app theme → Shiki bundled theme name. */
export type ResolvedTheme = 'light' | 'dark';
const THEMES = ['github-dark', 'github-light'] as const;

/** Map the app's resolved theme to the Shiki theme to render with. */
export function shikiThemeFor(theme: ResolvedTheme): string {
  return theme === 'light' ? 'github-light' : 'github-dark';
}

let highlighterPromise: Promise<Highlighter | null> | null = null;

/** Get (or lazily create) the shared highlighter. Resolves null on failure. */
export function getHighlighter(): Promise<Highlighter | null> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki')
      .then(({ createHighlighter }) =>
        createHighlighter({ themes: [...THEMES], langs: [...LANGS] }),
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Syntax-highlight `code` and return the inner HTML of each line separately, so
 * a caller (e.g. the diff view) can place each line in its own row. Resolves
 * null on failure; HTML is built from escaped token text + theme colors.
 */
export async function highlightLines(
  code: string,
  lang: string | undefined,
  theme: ResolvedTheme = 'dark',
): Promise<string[] | null> {
  const hl = await getHighlighter();
  if (!hl) return null;
  try {
    const resolved = normalizeLang(lang) as BundledLanguage | SpecialLanguage;
    const { tokens } = hl.codeToTokens(code, { lang: resolved, theme: shikiThemeFor(theme) });
    return tokens.map((line) =>
      line
        .map((t) => `<span style="color:${t.color ?? 'inherit'}">${escapeHtml(t.content)}</span>`)
        .join(''),
    );
  } catch {
    return null;
  }
}
