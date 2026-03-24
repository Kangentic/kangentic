import { useEffect } from 'react';
import { useBoardStore } from '../stores/board-store';
import { useProjectStore } from '../stores/project-store';

/**
 * Global keyboard shortcut: Ctrl+Shift+B (Windows/Linux) / Cmd+Shift+B (macOS)
 * toggles between Board and Backlog views.
 *
 * Matches the Ctrl+Shift+P pattern used for the command terminal.
 *
 * Guards:
 * - Only fires when a project is open
 */
export function useViewToggle() {
  const activeView = useBoardStore((state) => state.activeView);
  const setActiveView = useBoardStore((state) => state.setActiveView);
  const currentProject = useProjectStore((state) => state.currentProject);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!currentProject) return;

      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || !event.shiftKey || event.key !== 'B') return;

      event.preventDefault();
      setActiveView(activeView === 'board' ? 'backlog' : 'board');
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeView, setActiveView, currentProject]);
}
