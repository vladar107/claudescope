import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock.js';
import { ClampedText } from './ClampedText.js';
import { MAX_MARKDOWN_CHARS } from './limits.js';

export interface MarkdownProps {
  /** Markdown source to render. */
  children: string;
  /**
   * When false, render the text verbatim in a <pre> (no markdown parsing).
   * Useful for tool outputs / logs that aren't markdown. Default true.
   */
  markdown?: boolean;
  /** Extra className appended to the wrapper. */
  className?: string;
  /** Fully expand clamped text (e.g. an in-session search match is in the tail). */
  forceExpand?: boolean;
}

/**
 * Map markdown nodes to themed renderers. Fenced code blocks (those wrapped in
 * a <pre>) go through Shiki via {@link CodeBlock}; inline code stays as <code>.
 * react-markdown does not pass `inline` in v9+, so we detect block vs inline by
 * the presence of a `language-*` className (block fences) and newlines.
 */
const components: Components = {
  code({ className, children, ...rest }) {
    const text = String(children ?? '');
    const match = /language-(\w+)/.exec(className ?? '');
    const isBlock = match !== null || text.includes('\n');
    if (!isBlock) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    const lang = match?.[1];
    return <CodeBlock code={text.replace(/\n$/, '')} lang={lang} />;
  },
  // `pre` is handled by CodeBlock; unwrap so we don't double-nest <pre>.
  pre({ children }) {
    return <>{children as ReactNode}</>;
  },
  a({ children, href, ...rest }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  },
};

/**
 * Safe markdown renderer: react-markdown + remark-gfm (tables, strikethrough,
 * task lists, autolinks) with Shiki-highlighted code fences. Raw HTML is NOT
 * enabled, so content is sanitized by default. Falls back to a <pre> block when
 * `markdown` is false.
 */
function MarkdownImpl({ children, markdown = true, className, forceExpand = false }: MarkdownProps) {
  // Huge sources never hit the markdown parser unless the reader opts in.
  const [parseAnyway, setParseAnyway] = useState(false);
  const cls = className ? `tv-md ${className}` : 'tv-md';

  if (!markdown) {
    return (
      <ClampedText
        className={`tv-pre ${className ?? ''}`.trim()}
        text={children}
        forceExpand={forceExpand}
      />
    );
  }

  if (children.length > MAX_MARKDOWN_CHARS && !parseAnyway) {
    return (
      <div className={cls}>
        <ClampedText className="tv-pre" text={children} forceExpand={forceExpand} />
        <button type="button" className="tv-linkbtn tv-clamp-more" onClick={() => setParseAnyway(true)}>
          Render as markdown anyway
        </button>
      </div>
    );
  }

  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
