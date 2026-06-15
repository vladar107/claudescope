/**
 * Renders one {@link MemorySource} — an agent instruction file or a distilled
 * memory fact/document — as a card.
 *
 * The header carries a provenance/category chip, the title, an optional
 * description, and (for Claude facts) an "origin →" deep-link to the session
 * that produced the fact. The body is rendered through the shared, hardened
 * {@link Markdown} component, with `[[name]]` wiki-links rewritten to in-page
 * anchors that scroll to the matching fact in the same view. Unmatched links
 * degrade to plain text — we never synthesise an arbitrary URL.
 */

import { Fragment, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { MemorySource } from '@claudescope/shared';
import { Markdown } from '../../components';
import { anchorId, splitWikiLinks } from './wiki.js';

/** Human label + class modifier for a source's provenance. */
function provenanceMeta(source: MemorySource): { label: string; modifier: string } {
  return source.provenance === 'user-authored'
    ? { label: 'Instruction file', modifier: 'tv-memory-chip--user' }
    : { label: 'Agent memory', modifier: 'tv-memory-chip--agent' };
}

export interface MemorySourceCardProps {
  source: MemorySource;
  /**
   * Fact names present in the current view, used to resolve `[[name]]` links to
   * in-page anchors. Names not in this set render as plain text.
   */
  knownNames: ReadonlySet<string>;
}

export function MemorySourceCard({ source, knownNames }: MemorySourceCardProps) {
  const { label: provenanceLabel, modifier } = provenanceMeta(source);

  // Resolve `[[name]]` references in the body to in-page anchors. Plain markdown
  // (no wiki-links) is passed straight through to the renderer unchanged.
  const body = useMemo(
    () => renderBody(source.markdown, knownNames),
    [source.markdown, knownNames],
  );

  return (
    <article id={anchorId(source.title)} className="tv-card tv-memory-source">
      <header className="tv-memory-source__head">
        <span className={`tv-chip tv-memory-chip ${modifier}`}>{provenanceLabel}</span>
        {source.category ? (
          <span className="tv-chip tv-memory-chip tv-memory-chip--category">{source.category}</span>
        ) : null}
        <span className="tv-memory-source__title">{source.title}</span>
        {source.originSessionId ? (
          <Link
            to={`/sessions/${encodeURIComponent(source.originSessionId)}`}
            className="tv-memory-source__origin"
            title="Open the session that produced this fact"
          >
            origin →
          </Link>
        ) : null}
      </header>

      {source.description ? (
        <p className="tv-memory-source__desc tv-muted">{source.description}</p>
      ) : null}

      {source.empty ? (
        <p className="tv-muted">Empty scaffold — no memory recorded yet.</p>
      ) : (
        <div className="tv-memory-source__body">{body}</div>
      )}

      <footer className="tv-memory-source__foot tv-muted tv-mono">{source.sourcePath}</footer>
    </article>
  );
}

/**
 * Split the markdown on `[[name]]` references. Segments that match a known fact
 * become in-page anchor links; everything else (including unmatched links) is
 * rendered as ordinary markdown.
 */
function renderBody(markdown: string, knownNames: ReadonlySet<string>): ReactNode {
  const segments = splitWikiLinks(markdown);
  // No links → render the whole body in one pass (the common case).
  if (segments.length === 1 && segments[0]?.kind === 'text') {
    return <Markdown>{markdown}</Markdown>;
  }

  return segments.map((seg, i) => {
    if (seg.kind === 'link' && knownNames.has(seg.name)) {
      return (
        <a key={i} href={`#${anchorId(seg.name)}`} className="tv-memory-source__wiki">
          {seg.name}
        </a>
      );
    }
    // Unmatched link → its original `[[name]]` text; render as markdown so any
    // surrounding formatting still applies.
    const text = seg.kind === 'link' ? `[[${seg.name}]]` : seg.text;
    return (
      <Fragment key={i}>
        <Markdown className="tv-memory-source__inline">{text}</Markdown>
      </Fragment>
    );
  });
}
