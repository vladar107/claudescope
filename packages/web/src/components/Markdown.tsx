import { memo, useState, type ReactNode } from 'react';
import { Code2, Eye } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useRenderingPreferences } from '../rendering/RenderingProvider.js';
import { CodeBlock } from './CodeBlock.js';
import { ClampedText } from './ClampedText.js';
import { MAX_MARKDOWN_CHARS } from './limits.js';
import { MermaidBlock } from './MermaidBlock.js';

export interface MarkdownProps {
  /** Markdown source to render. */
  children: string;
  /** Exact text shown in source mode when rendering uses a cleaned derivative. */
  source?: string;
  /**
   * When false, render the text verbatim in a <pre> (no markdown parsing).
   * Useful for tool outputs / logs that aren't markdown. Default true.
   */
  markdown?: boolean;
  /** Extra className appended to the wrapper. */
  className?: string;
  /** Fully expand clamped text (e.g. an in-session search match is in the tail). */
  forceExpand?: boolean;
  /** Let the reader override the global rendered/source preference in place. */
  toggleable?: boolean;
  /** Temporarily reveal exact source (used by the in-session finder). */
  forceSource?: boolean;
}

/** Diagram-aware fenced-code renderer; ordinary languages stay on Shiki. */
function FencedCodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { mermaidEnabled } = useRenderingPreferences();
  if (lang?.toLowerCase() === 'mermaid' && mermaidEnabled) {
    return <MermaidBlock code={code} />;
  }
  return <CodeBlock code={code} lang={lang} />;
}

/**
 * Map markdown nodes to themed renderers. Mermaid fences use the local diagram
 * renderer; other fenced blocks go through Shiki via {@link CodeBlock}, while
 * inline code stays as <code>. react-markdown does not pass `inline` in v9+, so
 * we detect block vs inline by a `language-*` className and newlines.
 */
const components: Components = {
  code({ className, children, ...rest }) {
    const text = String(children ?? '');
    const match = /language-([\w-]+)/.exec(className ?? '');
    const isBlock = match !== null || text.includes('\n');
    if (!isBlock) {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    const lang = match?.[1];
    return <FencedCodeBlock code={text.replace(/\n$/, '')} lang={lang} />;
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
 * Restrict image sources to same-origin/relative or `data:` URLs. Transcript
 * markdown is untrusted content; a remote `![](http://attacker/x.png)` would
 * otherwise make the browser fetch it (tracking pixel / intranet probe). The CSP
 * already blocks this at the network layer — this closes it at the source so no
 * request is even attempted. Non-image URLs (e.g. link hrefs) keep react-markdown's
 * default sanitization, which still strips `javascript:` and friends.
 */
function urlTransform(url: string, _key: string, node: { tagName?: string }): string {
  if (node.tagName === 'img') {
    if (/^data:image\//i.test(url)) return url; // inlined image — safe
    if (/^\/\//.test(url) || /^[a-z][a-z0-9+.-]*:/i.test(url)) return ''; // protocol-relative or schemed → remote
    return url; // relative / same-origin path
  }
  return defaultUrlTransform(url);
}

/**
 * Safe markdown renderer: react-markdown + remark-gfm (tables, strikethrough,
 * task lists, autolinks), Shiki-highlighted code fences, and strict Mermaid
 * diagrams. Raw HTML is NOT enabled, so content is sanitized by default. Falls
 * back to a <pre> block when `markdown` is false.
 */
function MarkdownImpl({
  children,
  source = children,
  markdown = true,
  className,
  forceExpand = false,
  toggleable = false,
  forceSource = false,
}: MarkdownProps) {
  const { markdownEnabled } = useRenderingPreferences();
  // Huge sources never hit the markdown parser unless the reader opts in.
  const [parseAnyway, setParseAnyway] = useState(false);
  // null follows the browser preference; a click pins this block until unmount.
  const [localRendered, setLocalRendered] = useState<boolean | null>(null);
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

  // Browser preferences govern transcript blocks that opted into switching;
  // semantic document renderers (for example Memory) keep their existing mode.
  const preferredRendered = toggleable ? (localRendered ?? markdownEnabled) : true;
  const rendered = preferredRendered && !forceSource;
  const body = !rendered ? (
    <ClampedText
      className={`tv-pre ${className ?? ''}`.trim()}
      text={source}
      forceExpand={forceExpand}
    />
  ) : children.length > MAX_MARKDOWN_CHARS && !parseAnyway ? (
    <div className={cls}>
      <ClampedText className="tv-pre" text={children} forceExpand={forceExpand} />
      <button type="button" className="tv-linkbtn tv-clamp-more" onClick={() => setParseAnyway(true)}>
        Render as markdown anyway
      </button>
    </div>
  ) : (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {children}
      </ReactMarkdown>
    </div>
  );

  if (!toggleable) return body;

  return (
    <div className={rendered ? 'tv-markdown-shell' : 'tv-markdown-shell is-source'}>
      <div className="tv-markdown-shell__toolbar" data-finder-ignore>
        <button
          type="button"
          className="tv-markdown-mode"
          disabled={forceSource}
          aria-pressed={!rendered}
          title={
            forceSource
              ? 'Source is shown for the active search match'
              : rendered
                ? 'Show Markdown source'
                : 'Render Markdown'
          }
          onClick={() => setLocalRendered(!rendered)}
        >
          {rendered ? <Code2 size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
          {forceSource ? 'Source (search)' : rendered ? 'Source' : 'Rendered'}
        </button>
      </div>
      {body}
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
