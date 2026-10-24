import { popOutWindowManager } from '../../pop-out/pop-out-window-manager';
import { destroyLanesForTask } from '../../browser/browser-lane-manager';
import { parsePopOutInstanceKey } from '../../../shared/pop-out';

/**
 * Close every OS window that belongs to a task whose work just ended: its
 * pop-outs (Browser, Changes, each single-file diff) and the offscreen lane its
 * browser may have fallen back to.
 *
 * Call it on a TERMINAL transition only (Done, To Do, Backlog, delete, project
 * delete), never on a mid-board suspend: a parked task keeps its windows, as it
 * keeps its dev server. Call it AFTER the task's sessions have ended (suspended,
 * or killed and removed). A Browser pop-out closing destroys its guest, and the
 * lane hand-off (`browser-lane-handoff.ts`) stands an offscreen lane up for any
 * pane that unmounts while its task still has a live agent, so closing earlier
 * would open a lane for an agent about to stop. Call it BEFORE the reap and the
 * worktree removal, so the windows go at once rather than after them.
 *
 * The lane goes too because nothing else takes it at Done: a lane dies with its
 * session only when the session's record turns `exited`, and a Done move marks
 * it `suspended` first. A lane's own close never hands off, so destroying it
 * cannot stand another one up.
 *
 * Its own module, imported directly rather than through the helpers barrel:
 * many handler tests mock the barrel, and this has to run for real there.
 *
 * Best-effort: a window that fails to close never fails the move or delete.
 */
export function closeTaskWindows(projectId: string | null | undefined, taskId: string): void {
  try {
    const popOutCount = projectId ? popOutWindowManager.closeForTask({ projectId, taskId }) : 0;
    const laneCount = destroyLanesForTask(taskId);
    if (popOutCount > 0 || laneCount > 0) {
      console.log(`[TASK_WINDOWS] Closed ${popOutCount} pop-out(s) and ${laneCount} lane(s) for task ${taskId.slice(0, 8)}`);
    }
  } catch (error) {
    console.warn(`[TASK_WINDOWS] Closing windows failed for task ${taskId.slice(0, 8)} (non-fatal):`, error);
  }
}

/**
 * Close the windows of every task of a project whose tasks cannot be read: a
 * project deleted after its folder went away, or one whose task read failed.
 * The open pop-outs name their tasks in their instance keys, so each one found
 * gets the same close as a task whose work ended. The caller ends the
 * project's sessions first, for the reason `closeTaskWindows` gives.
 */
export function closeProjectTaskWindows(projectId: string): void {
  const taskIds = new Set<string>();
  for (const key of popOutWindowManager.listOpenKeys()) {
    const owner = parsePopOutInstanceKey(key);
    if (owner?.projectId === projectId) taskIds.add(owner.taskId);
  }
  for (const taskId of taskIds) closeTaskWindows(projectId, taskId);
}
