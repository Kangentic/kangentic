import type { IpcContext } from '../ipc/ipc-context';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import type { TaskStop } from '../pty/session-manager';

/**
 * Whether a card wears `agent-stopped`: its agent finished, and nothing will
 * move it until a person acts. Read from the run log, so it holds across a
 * restart and has one answer whichever event asked:
 *
 * - a stop the turn-end runner recorded for this visit (`column-stop.ts`);
 * - a workflow task waiting on its owner (the `Needs owner:` line) or stalled
 *   after its recovery ran out. A workflow task's spent row is neither, because
 *   recovery can still clear it.
 *
 * Every caller asks through here after the facts change, and a move out of the
 * column needs no write of its own: the visit changed, so the answer did.
 *
 * A spent row's stop lasts the visit, because no later turn can change it. Any
 * other lasts until the agent's next turn (`SessionManager.setTaskStopped`).
 */
export function refreshStoppedMark(context: IpcContext, projectId: string, taskId: string): void {
  try {
    context.sessionManager.setTaskStopped(taskId, taskStop(context, projectId, taskId));
  } catch (error) {
    // The mark is a reading of the log: a failed read changes no move.
    console.warn(`[turn-end] Could not read whether task ${taskId.slice(0, 8)} is stopped:`, error);
  }
}

function taskStop(context: IpcContext, projectId: string, taskId: string): TaskStop | null {
  const repos = getProjectRepos(context, projectId);
  const task = repos.tasks.getById(taskId);
  if (!task || task.archived_at) return null;
  const visitStartedAt = repos.taskMoves.visitStartedAt(task.id, task.swimlane_id);
  const stop = repos.automationRuns.columnStop(task.id, task.swimlane_id, visitStartedAt);
  if (stop) return stop.cause === 'spent-row' ? 'visit' : 'turn';
  if (task.workflow_id === null) return null;
  const waitingOrStalled = repos.automationRuns.isWaitingOnUser(task.id, task.swimlane_id, visitStartedAt)
    || repos.automationRuns.isStalled(task.id);
  return waitingOrStalled ? 'turn' : null;
}
