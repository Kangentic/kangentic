import { useProjectStore } from '../stores/project-store';
import { useBoardStore } from '../stores/board-store';

/**
 * Load the main window's open project, THEN its board, for a pop-out that
 * reads the board store (a task surface's window title, the Changes root).
 *
 * Never in the same tick. A fresh pop-out renderer starts with no
 * `currentProject`, and `loadBoard` drops any load during which the open
 * project changed, so a board load started alongside `loadCurrent()` began
 * under null, saw the project arrive, and published nothing. That left the
 * Browser and Changes windows on their empty states from 2026-10-20.
 *
 * The board is the AMBIENT project's, so it only serves a task in that project.
 * A surface that must work for a backgrounded task reads its row by params
 * instead (`usePopOutTaskRow`).
 */
export function loadAmbientBoard(signal: AbortSignal): void {
  void useProjectStore.getState().loadCurrent().then(() => {
    if (signal.aborted) return;
    void useBoardStore.getState().loadBoard();
  });
}
