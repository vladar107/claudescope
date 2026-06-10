import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeProvider.js';
import { getHighlighter, resolveLang, shikiThemeFor } from './highlighter.js';

export interface CodeBlockProps {
  /** Raw source code (already de-fenced). */
  code: string;
  /** Language hint from the markdown fence (e.g. "ts"). */
  lang?: string;
}

/**
 * Highlights a code block with Shiki. Renders an unhighlighted <pre> first,
 * then swaps in highlighted HTML once the (lazy) highlighter — and, if needed,
 * the on-demand grammar for `lang` — resolves. If Shiki fails to load or
 * doesn't know the language, the plain <pre> stays — so this component is
 * always safe to render.
 */
export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    Promise.all([getHighlighter(), resolveLang(lang)])
      .then(([hl, resolved]) => {
        if (cancelled || !hl) return;
        const out = hl.codeToHtml(code, { lang: resolved, theme: shikiThemeFor(resolvedTheme) });
        if (!cancelled) setHtml(out);
      })
      .catch(() => {
        /* keep plain fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang, resolvedTheme]);

  if (html) {
    // Shiki output is trusted (we generated it from the code string).
    return <div className="tv-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}
