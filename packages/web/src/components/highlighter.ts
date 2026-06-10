/**
 * Lazy, shared Shiki highlighter. Loading the full grammar/theme set is heavy,
 * so we create a single highlighter instance on first use and reuse it. A small
 * curated set is preloaded so common languages highlight without a flash; any
 * other language Shiki bundles is grammar-loaded on demand the first time it
 * appears (each grammar is its own lazy chunk), and only truly unknown
 * languages fall back to plaintext. All failures are swallowed so the caller
 * can render plain text.
 */

import type { BundledLanguage, Highlighter, SpecialLanguage } from 'shiki';

/** Grammars preloaded with the highlighter; everything else loads on demand. */
const PRELOADED_LANGS = [
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
        createHighlighter({ themes: [...THEMES], langs: [...PRELOADED_LANGS] }),
      )
      .catch(() => null);
  }
  return highlighterPromise;
}

/**
 * Normalize a language hint (markdown fence tag or file extension) to a Shiki
 * grammar id. Purely an alias map — whether the grammar exists is decided by
 * {@link resolveLang} against Shiki's bundled registry.
 */
export function normalizeLang(lang: string | undefined): string {
  if (!lang) return 'text';
  const l = lang.toLowerCase();
  const alias: Record<string, string> = {
    ts: 'typescript',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    sh: 'bash',
    zsh: 'bash',
    shell: 'bash',
    py: 'python',
    yml: 'yaml',
    md: 'markdown',
    rs: 'rust',
    golang: 'go',
    kt: 'kotlin',
    kts: 'kotlin',
    h: 'c',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hh: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    m: 'objective-c',
    mm: 'objective-cpp',
    pl: 'perl',
    ex: 'elixir',
    exs: 'elixir',
    erl: 'erlang',
    hs: 'haskell',
    gradle: 'groovy',
    gql: 'graphql',
  };
  return alias[l] ?? l;
}

// Grammar loads in flight or settled, so each language is requested once.
const langLoads = new Map<string, Promise<unknown>>();

/**
 * Resolve a language hint to a grammar the shared highlighter can actually
 * use, loading it on demand from Shiki's bundle when it isn't preloaded.
 * Resolves to 'text' for unknown languages or on any load failure.
 */
export async function resolveLang(lang: string | undefined): Promise<string> {
  const hl = await getHighlighter();
  if (!hl) return 'text';
  const id = normalizeLang(lang);
  if (id === 'text' || id === 'txt' || id === 'plaintext') return 'text';
  if (hl.getLoadedLanguages().includes(id)) return id;
  try {
    const { bundledLanguages } = await import('shiki');
    if (!(id in bundledLanguages)) return 'text';
    let load = langLoads.get(id);
    if (!load) {
      load = hl.loadLanguage(id as BundledLanguage).catch(() => {});
      langLoads.set(id, load);
    }
    await load;
    return hl.getLoadedLanguages().includes(id) ? id : 'text';
  } catch {
    return 'text';
  }
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
    const resolved = (await resolveLang(lang)) as BundledLanguage | SpecialLanguage;
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
