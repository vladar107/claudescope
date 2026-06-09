import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeProvider.js';
import { lineDiff, MAX_HIGHLIGHT } from './diff.js';
import { highlightLines } from './highlighter.js';

export interface LineDiffProps {
  oldText: string;
  newText: string;
  /** Shiki language hint (e.g. file extension) for syntax highlighting. */
  lang?: string;
}

/**
 * Red/green line diff between two strings, with Shiki syntax highlighting layered
 * on top. Each side is highlighted as a whole (so multi-line constructs tokenize
 * correctly), then lines are placed onto their diff backgrounds. Falls back to
 * plain text until — or unless — highlighting resolves.
 */
export function LineDiff({ oldText, newText, lang }: LineDiffProps) {
  const lines = lineDiff(oldText, newText);
  const [hl, setHl] = useState<{ old: string[]; neu: string[] } | null>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    let cancelled = false;
    if (oldText.length + newText.length > MAX_HIGHLIGHT) {
      setHl(null);
      return;
    }
    Promise.all([
      highlightLines(oldText, lang, resolvedTheme),
      highlightLines(newText, lang, resolvedTheme),
    ])
      .then(([o, n]) => {
        if (!cancelled && o && n) setHl({ old: o, neu: n });
      })
      .catch(() => {
        /* keep plain fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [oldText, newText, lang, resolvedTheme]);

  let oldIdx = 0;
  let newIdx = 0;
  return (
    <div className="tv-diff">
      {lines.map((l, i) => {
        const html = l.type === 'del' ? hl?.old[oldIdx] : hl?.neu[newIdx];
        if (l.type === 'del') oldIdx++;
        else if (l.type === 'add') newIdx++;
        else {
          oldIdx++;
          newIdx++;
        }
        return (
          <div key={i} className={`tv-diff__line tv-diff__line--${l.type}`}>
            <span className="tv-diff__gutter" aria-hidden="true">
              {l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}
            </span>
            {html != null ? (
              <span className="tv-diff__text" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
            ) : (
              <span className="tv-diff__text">{l.text === '' ? ' ' : l.text}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
