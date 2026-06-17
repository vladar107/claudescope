import type { RefObject } from 'react';
import { Search, X } from 'lucide-react';

export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  /** Extra class on the wrapper, e.g. `tv-field--grow`. */
  className?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * Shared search/filter input: a magnifier inside the field and a clear button,
 * so every search box across the app (Browse/project filters, global Search)
 * reads as the same control.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  autoFocus,
  ariaLabel,
  className,
  inputRef,
}: SearchFieldProps) {
  return (
    <div className={className ? `tv-field ${className}` : 'tv-field'}>
      <Search size={15} className="tv-field__icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        className="tv-field__input"
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="tv-field__clear"
          aria-label="Clear"
          onClick={() => onChange('')}
        >
          <X size={14} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
