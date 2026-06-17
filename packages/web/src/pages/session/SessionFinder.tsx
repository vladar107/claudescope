import type { RefObject } from 'react';
import { Search } from 'lucide-react';
import type { RoleFilter } from './search.js';

export interface SessionFinderProps {
  query: string;
  onQuery: (q: string) => void;
  roleFilter: RoleFilter;
  onRoleFilter: (r: RoleFilter) => void;
  count: number;
  activeIndex: number;
  onPrev: () => void;
  onNext: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * Always-visible in-session finder bar. Enter / Shift+Enter step matches;
 * Escape clears. Cmd/Ctrl+F (handled by the page) focuses the input.
 */
export function SessionFinder({
  query,
  onQuery,
  roleFilter,
  onRoleFilter,
  count,
  activeIndex,
  onPrev,
  onNext,
  inputRef,
}: SessionFinderProps) {
  // Mirror the page's 2-char minimum so a single character doesn't read as "No matches".
  const hasQuery = query.trim().length >= 2;
  return (
    <div className="tv-finder" role="search">
      <span className="tv-finder__icon" aria-hidden="true">
        <Search size={14} />
      </span>
      <input
        ref={inputRef}
        type="text"
        className="tv-finder__input"
        placeholder="Find in session…  (⌘F)"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (count > 0) (e.shiftKey ? onPrev : onNext)();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onQuery('');
            e.currentTarget.blur();
          }
        }}
      />
      <select
        className="tv-finder__filter"
        aria-label="Filter by role"
        value={roleFilter}
        onChange={(e) => onRoleFilter(e.target.value as RoleFilter)}
      >
        <option value="all">All</option>
        <option value="user">User</option>
        <option value="assistant">Assistant</option>
      </select>
      <span className="tv-finder__count">
        {hasQuery ? (count > 0 ? `${activeIndex + 1}/${count}` : 'No matches') : ''}
      </span>
      <button
        type="button"
        className="tv-finder__nav"
        onClick={onPrev}
        disabled={count === 0}
        aria-label="Previous match"
        title="Previous (Shift+Enter)"
      >
        ‹
      </button>
      <button
        type="button"
        className="tv-finder__nav"
        onClick={onNext}
        disabled={count === 0}
        aria-label="Next match"
        title="Next (Enter)"
      >
        ›
      </button>
    </div>
  );
}
