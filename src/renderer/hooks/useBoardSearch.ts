import { useEffect } from 'react';
import { useBoardStore } from '../stores/board-store';
import { useToastStore } from '../stores/toast-store';

/**
 * Registers/unregisters the Ctrl+F / Cmd+F keyboard listener
 * that toggles the board search bar visibility.
 */
export function useBoardSearch(
  showBoardSearch: boolean,
  updateConfig: (patch: Record<string, unknown>) => void,
): void {
  useEffect(() => {
    const modifierKey = window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl';
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        event.preventDefault();
        if (showBoardSearch) {
          // Toggle off if visible and query is empty
          const currentQuery = useBoardStore.getState().searchQuery;
          if (!currentQuery) {
            useBoardStore.getState().setSearchQuery('');
            updateConfig({ showBoardSearch: false });
            useToastStore.getState().addToast({
              message: `Press ${modifierKey}+F to search`,
              variant: 'info',
            });
            return;
          }
          // If query is active, just focus and select
          const input = document.querySelector('[data-testid="board-search-input"]') as HTMLInputElement | null;
          input?.focus();
          input?.select();
        } else {
          updateConfig({ showBoardSearch: true });
          // Focus input on next tick (after render when bar appears)
          requestAnimationFrame(() => {
            const input = document.querySelector('[data-testid="board-search-input"]') as HTMLInputElement | null;
            input?.focus();
            input?.select();
          });
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showBoardSearch, updateConfig]);
}
