/**
 * Auto-closes a task-detail window the moment its task leaves the active board -
 * moved to Done (and archived), deleted, or sent to the backlog. Mounted once by
 * `WindowLayer`, so it survives the content remount the move causes: a per-window
 * effect inside `TaskDetailWindow` cannot, because the instant the task leaves
 * `tasks` (before `archivedTasks` reloads) `WindowContent` swaps to its "no longer
 * available" placeholder and unmounts the detail surface. That gap is exactly the
 * ~1s grey flash we want to remove - close here instead and the window goes away
 * immediately, never showing the placeholder.
 *
 * A window opened DIRECTLY on an already-done/archived task (from the Completed
 * Tasks list) carries `openedDone` and is left alone: only a TRANSITION off the
 * board closes a window.
 */

import { useEffect } from 'react';
import { useBoardStore } from '../../stores/board-store';
import { useWindowStore } from '../store/window-store';

export function useWindowAutoCloseOnDone(): void {
  const windows = useWindowStore((state) => state.windows);
  const tasks = useBoardStore((state) => state.tasks);
  const swimlanes = useBoardStore((state) => state.swimlanes);
  const completingTaskIds = useBoardStore((state) => state.completingTaskIds);

  useEffect(() => {
    const closeWindow = useWindowStore.getState().closeWindow;
    for (const managedWindow of Object.values(windows)) {
      // Opened on an already-done/archived task -> leave it (Completed-Tasks review).
      if (managedWindow.openedDone) continue;
      const task = tasks.find((candidate) => candidate.id === managedWindow.taskId);
      // Close on the EARLIEST off-board signal so the window never lingers:
      //  - a drag onto Done arms `completingTaskIds` synchronously (before the fly
      //    and the archive), so the window closes the instant you drop;
      //  - a menu / direct move removes the task from `tasks` (archived, deleted,
      //    backlogged) - close before `archivedTasks` reloads and the placeholder
      //    can show;
      //  - a non-archiving Done column keeps it in `tasks` at a done-role lane.
      const completing = completingTaskIds.has(managedWindow.taskId);
      const goneFromBoard = !task;
      const inDoneLane = !!task && swimlanes.find((lane) => lane.id === task.swimlane_id)?.role === 'done';
      if (completing || goneFromBoard || inDoneLane) {
        closeWindow(managedWindow.id);
      }
    }
  }, [windows, tasks, swimlanes, completingTaskIds]);
}
