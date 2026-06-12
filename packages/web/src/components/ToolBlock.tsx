import { useState } from 'react';
import type { ContentBlock, ToolInteraction } from '@claudescope/shared';
import { Collapsible } from './Collapsible.js';
import { CodeBlock } from './CodeBlock.js';
import { ClampedText } from './ClampedText.js';
import { Markdown } from './Markdown.js';
import { LineDiff } from './LineDiff.js';
import { extOf, MAX_HIGHLIGHT } from './diff.js';
import { extractImage } from './image.js';

export interface ToolBlockProps {
  /** The parsed tool interaction (tool_use paired with its tool_result). */
  tool: ToolInteraction;
  /** Open by default. Default false (collapsed for dense reading). */
  defaultOpen?: boolean;
  /** Force the block open (e.g. it contains an in-session search match). */
  forceOpen?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
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

/** Syntax-highlighted code, falling back to clamped plain text for large payloads. */
function Code({ code, lang, forceExpand = false }: { code: string; lang?: string; forceExpand?: boolean }) {
  if (code.length > MAX_HIGHLIGHT) {
    return <ClampedText className="tv-code-plain" text={code} code forceExpand={forceExpand} />;
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

/** Render normalized tool_result content blocks. Text/JSON shown as (clamped) text. */
function renderResultBlocks(blocks: ContentBlock[], forceExpand: boolean) {
  return blocks.map((block, i) => {
    if (block.type === 'text')
      return <Markdown key={i} markdown={false} forceExpand={forceExpand}>{block.text}</Markdown>;
    if (block.type === 'thinking')
      return <Markdown key={i} markdown={false} forceExpand={forceExpand}>{block.thinking}</Markdown>;
    if (block.type === 'image') {
      const src = extractImage(block);
      if (src) {
        return (
          <figure key={i} className="tv-attachment">
            <img src={src} alt="tool result image" />
            <figcaption className="tv-muted">image</figcaption>
          </figure>
        );
      }
    }
    return <Markdown key={i} markdown={false} forceExpand={forceExpand}>{stringifyInput(block)}</Markdown>;
  });
}

function ResultSection({
  tool,
  isError,
  forceExpand,
}: {
  tool: ToolInteraction;
  isError: boolean;
  forceExpand: boolean;
}) {
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
      {renderResultBlocks(tool.result.content, forceExpand)}
    </div>
  );
}

/** Tool-specific body: diffs for edits, highlighted code for files/commands. */
function ToolBody({
  tool,
  isError,
  forceOpen,
}: {
  tool: ToolInteraction;
  isError: boolean;
  forceOpen: boolean;
}) {
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
          <ResultSection tool={tool} isError={isError} forceExpand={forceOpen} />
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
          <ResultSection tool={tool} isError={isError} forceExpand={forceOpen} />
        </>
      );
    }
    case 'Write': {
      const fp = str(input.file_path);
      return (
        <>
          {fp ? <FileHeader path={fp} /> : null}
          <Code code={str(input.content) ?? ''} lang={extOf(fp)} forceExpand={forceOpen} />
          <ResultSection tool={tool} isError={isError} forceExpand={forceOpen} />
        </>
      );
    }
    case 'Read': {
      const fp = str(input.file_path);
      const text = resultText(tool.result);
      // When the result has non-text blocks (e.g. an image from reading a PNG),
      // resultText is empty — render via ResultSection so image blocks are shown
      // properly instead of an empty code block.
      const hasNonTextBlocks = tool.result
        ? tool.result.content.some((b) => b.type !== 'text' && b.type !== 'thinking')
        : false;
      return (
        <>
          {fp ? <FileHeader path={fp} /> : null}
          {tool.result ? (
            text || !hasNonTextBlocks ? (
              <Code code={text} lang={extOf(fp)} forceExpand={forceOpen} />
            ) : (
              <ResultSection tool={tool} isError={isError} forceExpand={forceOpen} />
            )
          ) : (
            <ResultSection tool={tool} isError={isError} forceExpand={forceOpen} />
          )}
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
          <Code code={str(input.command) ?? ''} lang="bash" forceExpand={forceOpen} />
          {out ? (
            <div className="tv-tool__section">
              <p className="tv-tool__section-label">{isError ? 'Output (error)' : 'Output'}</p>
              <ClampedText className="tv-code-plain" text={out} code forceExpand={forceOpen} />
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
            <Code code={stringifyInput(tool.input)} lang="json" forceExpand={forceOpen} />
          </div>
          <ResultSection tool={tool} isError={isError} forceExpand={forceOpen} />
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
      <ToolBody tool={tool} isError={isError} forceOpen={forceOpen} />
    </Collapsible>
  );
}
