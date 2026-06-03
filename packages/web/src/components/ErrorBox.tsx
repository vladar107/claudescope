import { ApiError } from '../api/client.js';

/** Standard error surface for failed loads. Optionally offers a retry button. */
export interface ErrorBoxProps {
  /** The error to display; strings and Error/ApiError instances are supported. */
  error: unknown;
  /** Heading shown above the detail. */
  title?: string;
  /** When provided, renders a "Retry" button that invokes this callback. */
  onRetry?: () => void;
}

/** Best-effort human-readable message from an unknown thrown value. */
function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function ErrorBox({ error, title = 'Something went wrong', onRetry }: ErrorBoxProps) {
  return (
    <div className="tv-error" role="alert">
      <div className="tv-error__title">{title}</div>
      <div className="tv-error__detail">{describe(error)}</div>
      {onRetry ? (
        <button type="button" className="tv-error__retry" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
