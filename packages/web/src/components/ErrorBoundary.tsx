import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorBox } from './ErrorBox.js';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Heading for the default ErrorBox fallback. */
  title?: string;
  /** Custom fallback; receives the caught error and a reset callback. */
  fallback?: (error: unknown, reset: () => void) => ReactNode;
  /**
   * When any value here changes (shallow compare), the boundary clears its error
   * and re-renders its children — e.g. pass `[pathname]` so navigating away from
   * a crashed page recovers it, or `[block]` so a fresh payload retries.
   */
  resetKeys?: unknown[];
}

interface ErrorBoundaryState {
  error: unknown;
}

/**
 * Catches render-time exceptions in its subtree so one throw degrades locally
 * instead of white-screening the whole SPA. Complements {@link ErrorBox} (the
 * default fallback): ErrorBox surfaces *async* fetch failures that pages store in
 * state, while an error boundary catches errors thrown during render/lifecycle —
 * the two are complementary, not overlapping. React 19 error boundaries must be
 * class components (getDerivedStateFromError / componentDidCatch are class-only).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Single-user, 127.0.0.1 app — logging transcript-derived errors locally is fine.
    console.error('Render error caught by ErrorBoundary', error, info);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error != null && !sameKeys(prev.resetKeys, this.props.resetKeys)) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error != null) {
      const { fallback, title } = this.props;
      if (fallback) return fallback(error, this.reset);
      return (
        <ErrorBox
          error={error}
          title={title ?? 'Something went wrong rendering this view'}
          onRetry={this.reset}
        />
      );
    }
    return this.props.children;
  }
}

/** Shallow array compare for resetKeys. */
function sameKeys(a?: unknown[], b?: unknown[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}
