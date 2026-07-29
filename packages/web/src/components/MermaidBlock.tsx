import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeProvider.js';
import { ClampedText } from './ClampedText.js';
import { MAX_DIAGRAM_CHARS } from './limits.js';

export interface MermaidBlockProps {
  /** Mermaid source, already stripped of the markdown fence. */
  code: string;
}

type RenderState =
  | { status: 'loading' }
  | { status: 'rendered'; svg: string }
  | { status: 'failed'; message: string };

let renderSequence = 0;

/** Keep arbitrary parser errors short and single-line in the transcript UI. */
function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240) || 'Unknown rendering error';
}

/**
 * Lazy, local Mermaid renderer. Transcript text never leaves the browser;
 * strict mode plus the app CSP keep diagram-authored HTML, scripts, links, and
 * remote resources from becoming an active-content escape hatch.
 */
export function MermaidBlock({ code }: MermaidBlockProps) {
  const { resolvedTheme } = useTheme();
  const [state, setState] = useState<RenderState>(() =>
    code.length > MAX_DIAGRAM_CHARS
      ? {
          status: 'failed',
          message: `Diagram is too large to render (${code.length.toLocaleString('en-US')} characters).`,
        }
      : { status: 'loading' },
  );

  useEffect(() => {
    if (code.length > MAX_DIAGRAM_CHARS) {
      setState({
        status: 'failed',
        message: `Diagram is too large to render (${code.length.toLocaleString('en-US')} characters).`,
      });
      return;
    }

    let cancelled = false;
    setState({ status: 'loading' });
    const renderId = `claudescope-mermaid-${++renderSequence}`;

    void import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          maxTextSize: MAX_DIAGRAM_CHARS,
          theme: resolvedTheme === 'dark' ? 'dark' : 'default',
        });
        // Mermaid's renderers look up their temporary SVG through `document`,
        // so the container must be connected while layout is calculated.
        const staging = document.createElement('div');
        staging.setAttribute('aria-hidden', 'true');
        Object.assign(staging.style, {
          position: 'fixed',
          left: '-100000px',
          top: '0',
          width: '1000px',
          visibility: 'hidden',
          pointerEvents: 'none',
        });
        document.body.append(staging);

        try {
          const { svg } = await mermaid.render(renderId, code, staging);
          if (!cancelled) setState({ status: 'rendered', svg });
        } finally {
          staging.remove();
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'failed', message: readableError(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [code, resolvedTheme]);

  if (state.status === 'loading') {
    return (
      <div className="tv-mermaid tv-mermaid--loading" role="status" aria-live="polite">
        Rendering Mermaid diagram…
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <figure className="tv-mermaid tv-mermaid--failed">
        <figcaption className="tv-mermaid__error">
          Mermaid diagram could not be rendered: {state.message}
        </figcaption>
        <ClampedText className="tv-pre" text={code} code />
      </figure>
    );
  }

  return (
    <div
      className="tv-mermaid tv-mermaid__svg"
      role="img"
      aria-label="Mermaid diagram"
      // Mermaid generated this SVG under strict mode; raw transcript HTML is
      // never passed through to this sink.
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
