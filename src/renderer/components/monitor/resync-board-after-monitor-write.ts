/**
 * Bring the main window's board up to date after a main-window write the board
 * store did not make: the Agent Monitor's writes, the Workflows canvas menu's,
 * and the board card's Pause or Resume session row.
 *
 * The monitor writes straight to the project-stamped IPC (its row may belong to
 * any project), so the board store never sees the write. Main sends no push for
 * a write from the main window (`renderer`-origin moves and plain updates are
 * silent, because the board updates optimistically), and closing the monitor
 * reloads nothing. Without this the board under the overlay kept a moved card in
 * its old column, or showed a deleted one, until some other reload.
 *
 * The Workflows canvas menu calls it after a Move to on a card of another board
 * and after its Pause or Resume session row, and the board card after its own
 * session row. Those writes are the same project-stamped IPC from the main
 * window, so main is just as silent about them.
 *
 * - A task of the open project: reload the board and the backlog (a Backlog
 *   demote changes both). Routed through `enqueueReload`, so a reload that lands
 *   mid-drag is held until the drag ends. A caller whose write cannot touch the
 *   backlog (a session toggle, a canvas Move to) pays one extra backlog read,
 *   kept so every caller runs this one policy.
 * - A task of another project: drop that project's warm-switch snapshot, so the
 *   next switch to it loads fresh instead of restoring the old board.
 * - In the detached monitor window: nothing. That renderer has its own stores
 *   and cannot reach the main window's, so main pushes
 *   `TASK_CHANGED_IN_OTHER_WINDOW` there instead, and the main window applies
 *   this same policy (`useAgentDrivenInvalidation`).
 */

import { readPopOutDescriptor } from '../../pop-out/read-descriptor';
import { enqueueReload } from '../../lib/session-update-coalescer';
import { useBoardStore } from '../../stores/board-store';
import { useBacklogStore } from '../../stores/backlog-store';
import { useProjectStore } from '../../stores/project-store';
import { invalidateProject } from '../../stores/project-cache';

export function resyncBoardAfterMonitorWrite(projectId: string): void {
  if (readPopOutDescriptor() !== null) return;
  if (projectId === useProjectStore.getState().currentProject?.id) {
    enqueueReload('board', () => useBoardStore.getState().loadBoard());
    enqueueReload('backlog', () => useBacklogStore.getState().loadBacklog());
    return;
  }
  invalidateProject(projectId);
}
