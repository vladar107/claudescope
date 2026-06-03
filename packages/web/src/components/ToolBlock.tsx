import { useEffect, useState } from 'react';
import type { ContentBlock, ToolInteraction } from '@claudescope/shared';
import { Collapsible } from './Collapsible.js';
import { CodeBlock } from './CodeBlock.js';
import { Markdown } from './Markdown.js';
import { highlightLines } from './highlighter.js';
import { lineDiff } from './diff.js';

export interface ToolBlockProps {
  /** The parsed tool interaction (tool_use paired with its tool_result). */
  tool: ToolInteraction;
  /** Open by default. Default false (collapsed for dense reading). */
  defaultOpen?: boolean;
  /** Force the block open (e.g. it contains an in-session search match). */
  forceOpen?: boolean;
}

// Skip syntax highlighting for very large payloads (Shiki gets slow).
const MAX_HIGHLIGHT = 60_000;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
/** File extension (used as a Shiki language hint) from a path. */
function extOf(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
}
/** Plain text of a tool result's content blocks. */
function resultText(result: ToolInteraction['result']): string {
  if (!result) return '';
  return result.content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : ''))
    .join('\n')
    .trim();
}
function stringifyInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Syntax-highlighted code, falling back to plain text for large payloads. */
function Code({ code, lang }: { code: string; lang?: string }) {
  if (code.length > MAX_HIGHLIGHT) {
    return (
      <pre className="tv-code-plain">
        <code>{code}</code>
      </pre>
    );
  }
  return <CodeBlock code={code} lang={lang} />;
}

function FileHeader({ path, note }: { path: string; note?: string }) {
  return (
    <p className="tv-tool__file tv-mono">
      {path}
      {note ? <span className="tv-muted"> · {note}</span> : null}
    </p>
  );
}

/**
 * Red/green line diff between two strings, with Shiki syntax highlighting layered
 * on top. Each side is highlighted as a whole (preserving multi-line context),
 * then lines are placed onto their diff backgrounds. Falls back to plain text
 * until (or unless) highlighting resolves.
 */
function LineDiff({ oldText, newText, lang }: { oldText: string; newText: string; lang?: string }) {
  const lines = lineDiff(oldText, newText);
  const [hl, setHl] = useState<{ old: string[]; neu: string[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const big = oldText.length + newText.length > MAX_HIGHLIGHT;
    if (big) {
      setHl(null);
      return;
    }
    Promise.all([highlightLines(oldText, lang), highlightLines(newText, lang)])
      .then(([o, n]) => {
        if (!cancelled && o && n) setHl({ old: o, neu: n });
      })
      .catch(() => {
        /* keep plain fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [oldText, newText, lang]);

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

/** Render normalized tool_result content blocks. Text/JSON shown as text. */
function renderResultBlocks(blocks: ContentBlock[]) {
  return blocks.map((block, i) => {
    if (block.type === 'text') return <Markdown key={i} markdown={false}>{block.text}</Markdown>;
    if (block.type === 'thinking') return <Markdown key={i} markdown={false}>{block.thinking}</Markdown>;
    return <Markdown key={i} markdown={false}>{stringifyInput(block)}</Markdown>;
  });
}

function ResultSection({ tool, isError }: { tool: ToolInteraction; isError: boolean }) {
  if (!tool.result) {
    return (
      <div className="tv-tool__section">
        <p className="tv-tool__section-label tv-muted">No result (pending or session ended)</p>
      </div>
    );
  }
  return (
    <div className="tv-tool__section">
      <p className="tv-tool__section-label">{isError ? 'Result (error)' : 'Result'}</p>
      {renderResultBlocks(tool.result.content)}
    </div>
  );
}

/** Tool-specific body: diffs for edits, highlighted code for files/commands. */
function ToolBody({ tool, isError }: { tool: ToolInteraction; isError: boolean }) {
  const input = asRecord(tool.input);

  switch (tool.name) {
    case 'Edit': {
      const fp = str(input.file_path);
      return (
        <>
          {fp ? <FileHeader path={fp} note={input.replace_all ? 'replace all' : undefined} /> : null}
          <LineDiff
            oldText={str(input.old_string) ?? ''}
            newText={str(input.new_string) ?? ''}
            lang={extOf(fp)}
          />
          <ResultSection tool={tool} isError={isError} />
        </>
      );
    }
    case 'MultiEdit': {
      const fp = str(input.file_path);
      const edits = Array.isArray(input.edits) ? input.edits : [];
      return (
        <>
          {fp ? <FileHeader path={fp} /> : null}
          {edits.map((e, i) => {
            const er = asRecord(e);
            return (
              <div className="tv-tool__section" key={i}>
                <p className="tv-tool__section-label tv-muted">Edit {i + 1}</p>
                <LineDiff
                  oldText={str(er.old_string) ?? ''}
                  newText={str(er.new_string) ?? ''}
                  lang={extOf(fp)}
                />
              </div>
            );
          })}
          <ResultSection tool={tool} isError={isError} />
        </>
      );
    }
    case 'Write': {
      const fp = str(input.file_path);
      return (
        <>
          {fp ? <FileHeader path={fp} /> : null}
          <Code code={str(input.content) ?? ''} lang={extOf(fp)} />
          <ResultSection tool={tool} isError={isError} />
        </>
      );
    }
    case 'Read': {
      const fp = str(input.file_path);
      const text = resultText(tool.result);
      return (
        <>
          {fp ? <FileHeader path={fp} /> : null}
          {tool.result ? <Code code={text} lang={extOf(fp)} /> : <ResultSection tool={tool} isError={isError} />}
        </>
      );
    }
    case 'Bash': {
      const out = resultText(tool.result);
      return (
        <>
          {str(input.description) ? (
            <p className="tv-tool__section-label tv-muted">{str(input.description)}</p>
          ) : null}
          <Code code={str(input.command) ?? ''} lang="bash" />
          {out ? (
            <div className="tv-tool__section">
              <p className="tv-tool__section-label">{isError ? 'Output (error)' : 'Output'}</p>
              <pre className="tv-code-plain">
                <code>{out}</code>
              </pre>
            </div>
          ) : null}
        </>
      );
    }
    default:
      return (
        <>
          <div className="tv-tool__section">
            <p className="tv-tool__section-label">Input</p>
            <Code code={stringifyInput(tool.input)} lang="json" />
          </div>
          <ResultSection tool={tool} isError={isError} />
        </>
      );
  }
}

/**
 * Collapsible shell for a single tool call. The body is tool-aware: Edit/
 * MultiEdit render a red/green diff, Write/Read/Bash render syntax-highlighted
 * code, and everything else falls back to highlighted JSON + text.
 */
export function ToolBlock({ tool, defaultOpen = false, forceOpen = false }: ToolBlockProps) {
  const isError = tool.result?.isError === true;
  const className = isError ? 'tv-collapsible--tool tv-collapsible--error' : 'tv-collapsible--tool';
  const [userOpen, setUserOpen] = useState(defaultOpen);

  return (
    <Collapsible
      className={className}
      open={userOpen || forceOpen}
      onToggle={setUserOpen}
      icon="⚙"
      title={tool.name}
      subtitle={tool.id}
      headerExtra={
        isError ? (
          <span className="tv-chip" style={{ color: 'var(--tv-danger)' }}>
            error
          </span>
        ) : null
      }
    >
      <ToolBody tool={tool} isError={isError} />
    </Collapsible>
  );
}
