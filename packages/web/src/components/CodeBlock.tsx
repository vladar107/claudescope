import { useEffect, useState } from 'react';
import { getHighlighter, normalizeLang, SHIKI_THEME } from './highlighter.js';

export interface CodeBlockProps {
  /** Raw source code (already de-fenced). */
  code: string;
  /** Language hint from the markdown fence (e.g. "ts"). */
  lang?: string;
}

/**
 * Highlights a code block with Shiki. Renders an unhighlighted <pre> first,
 * then swaps in highlighted HTML once the (lazy) highlighter resolves. If Shiki
 * fails to load or doesn't know the language, the plain <pre> stays — so this
 * component is always safe to render.
 */
export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const resolved = normalizeLang(lang);

  useEffect(() => {
    let cancelled = false;
    getHighlighter()
      .then((hl) => {
        if (cancelled || !hl) return;
        const out = hl.codeToHtml(code, { lang: resolved, theme: SHIKI_THEME });
        if (!cancelled) setHtml(out);
      })
      .catch(() => {
        /* keep plain fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [code, resolved]);

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
