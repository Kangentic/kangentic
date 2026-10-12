import { useBoardStore } from '../stores/board-store';
import { useProjectStore } from '../stores/project-store';
import { useKeybinding } from './useKeybinding';

/**
 * The view shortcuts, read from the central keybinding registry:
 * - Ctrl/Cmd+Shift+B switches Board and Backlog; pressed in Workflows, it goes
 *   to Board.
 * - Ctrl/Cmd+Shift+L opens Workflows; pressed there, it returns to the view
 *   you came from.
 *
 * Guards:
 * - Only fires when a project is open.
 */
export function useViewToggle() {
  const activeView = useBoardStore((state) => state.activeView);
  const viewBeforeWorkflows = useBoardStore((state) => state.viewBeforeWorkflows);
  const setActiveView = useBoardStore((state) => state.setActiveView);
  const currentProject = useProjectStore((state) => state.currentProject);

  // Preserve the original behavior of preventDefault without stopPropagation.
  useKeybinding(
    'view.toggleBoardBacklog',
    () => setActiveView(activeView === 'board' ? 'backlog' : 'board'),
    { enabled: !!currentProject, stopPropagation: false },
  );
  useKeybinding(
    'view.toggleWorkflows',
    () => setActiveView(activeView === 'workflows' ? viewBeforeWorkflows : 'workflows'),
    { enabled: !!currentProject, stopPropagation: false },
  );
}
