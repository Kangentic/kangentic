import React, { useRef, useEffect, useCallback } from 'react';
import { Search, X, EyeOff } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useToastStore } from '../../stores/toast-store';

const modifierKey = window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl';

interface BoardSearchBarProps {
  totalCount: number;
  matchCount: number;
  autoFocus?: boolean;
  /** Optional filter button element rendered before the dismiss button. */
  filterButton?: React.ReactNode;
}

export const BoardSearchBar = React.memo(function BoardSearchBar({ totalCount, matchCount, autoFocus, filterButton }: BoardSearchBarProps) {
  const searchQuery = useBoardStore((state) => state.searchQuery);
  const setSearchQuery = useBoardStore((state) => state.setSearchQuery);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus only when explicitly requested (e.g., bar just became visible via Ctrl+F)
  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  const handleClear = useCallback(() => {
    setSearchQuery('');
    inputRef.current?.focus();
  }, [setSearchQuery]);

  const handleDismiss = useCallback(() => {
    setSearchQuery('');
    updateConfig({ showBoardSearch: false });
    useToastStore.getState().addToast({
      message: `Press ${modifierKey}+F to search`,
      variant: 'info',
    });
  }, [setSearchQuery, updateConfig]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (searchQuery) {
        setSearchQuery('');
      } else {
        inputRef.current?.blur();
      }
    }
    // Ctrl+F inside the input: dismiss if query is empty, otherwise select all
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault();
      event.stopPropagation();
      if (!searchQuery) {
        handleDismiss();
      } else {
        inputRef.current?.select();
      }
    }
  }, [searchQuery, handleDismiss]);

  const hasQuery = searchQuery.length > 0;

  return (
    <div
      data-testid="board-search-bar"
      className="mx-4 mt-4 mb-0 flex items-center gap-2 h-8 rounded-md bg-surface-raised/50 border border-edge/30 px-2.5"
    >
      <Search size={14} className="flex-shrink-0 text-fg-disabled" />
      <input
        ref={inputRef}
        data-testid="board-search-input"
        type="text"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search tasks..."
        className="flex-1 min-w-0 bg-transparent text-sm text-fg placeholder-fg-disabled outline-none"
      />

      {/* Right side: shortcut badge or match count + clear */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {hasQuery ? (
          <>
            <span data-testid="board-search-match-count" className="text-xs text-fg-muted tabular-nums whitespace-nowrap">
              {matchCount} of {totalCount}
            </span>
            <button
              type="button"
              data-testid="board-search-clear"
              onClick={handleClear}
              className="p-0.5 text-fg-disabled hover:text-fg-muted transition-colors"
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <kbd className="text-[11px] text-fg-muted bg-surface-hover/80 border border-edge/50 rounded px-1.5 py-0.5 font-mono leading-none">
            {modifierKey}+F
          </kbd>
        )}

        {filterButton}

        {/* Dismiss button */}
        <button
          type="button"
          data-testid="board-search-dismiss"
          onClick={handleDismiss}
          className="p-1 text-fg-muted hover:text-fg transition-colors ml-0.5 rounded hover:bg-surface-hover/60"
          aria-label="Hide search bar"
        >
          <EyeOff size={14} />
        </button>
      </div>
    </div>
  );
});
