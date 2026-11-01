import type { Swimlane, Task } from '../../../shared/types';
import type { IpcContext } from '../../ipc/ipc-context';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import { handleTaskMove } from '../../ipc/handlers/task-move';
import { resolveMoveTarget, routeOf } from '../move-target';
import { deliverMessageAfterMove } from './deliver-message';

/**
 * A Move to column row's move (`AutomationContext.moveTask`), shared by the
 * turn-end runner and Run again so a re-run moves the task exactly as a turn
 * end does. Resolves once the move is committed and the destination's own
 * enter rows have run; the row's message then reaches the agent there in the
 * background, once its turn ends, so the run row does not wait an hour on a
 * long first turn.
 *
 * Both callers run the row outside the task lock, because `handleTaskMove`
 * takes it and `withTaskLock` is not reentrant. So the task is read again here,
 * and the move refuses inside the lock if it has left the row's column by then
 * (`expectedFromSwimlaneId`): Next column resolves from the row's column, which
 * would send the task on from somewhere it no longer is.
 */
export async function moveTaskFromRow(
  context: IpcContext,
  input: {
    projectId: string;
    projectPath: string | null;
    task: Task;
    fromColumn: Swimlane;
    move: { column: string | null; message: string | null; reason: string };
    /**
     * The turn-end group's own move, which must not abort the group that made it
     * (`supersedeTurnEndWork`'s `exceptOwnGroup`). False for Run again, which
     * runs in no group, so its move stops any turn-end work the task has going.
     */
    fromTurnEndGroup: boolean;
  },
): Promise<{ columnName: string }> {
  const { projectId, projectPath, task, fromColumn, move } = input;
  const repos = getProjectRepos(context, projectId);
  if (repos.tasks.getById(task.id)?.swimlane_id !== fromColumn.id) {
    throw new Error(`The task left ${fromColumn.name} before it could be moved.`);
  }
  // A workflow task's Next column is the next one on its route.
  const target = resolveMoveTarget(repos.swimlanes.list(), fromColumn.id, move.column, routeOf(task));
  if (!target.ok) throw new Error(target.reason);
  const message = move.message?.trim() ?? '';

  await handleTaskMove(
    context,
    { taskId: task.id, targetSwimlaneId: target.column.id, targetPosition: repos.tasks.list(target.column.id).length },
    'automation',
    projectId,
    projectPath,
    {
      moveReason: move.reason,
      fromTurnEndGroup: input.fromTurnEndGroup,
      expectedFromSwimlaneId: fromColumn.id,
      ...(message ? { carriesMessage: true } : {}),
    },
  );

  const moved = repos.tasks.getById(task.id);
  if (!moved || moved.swimlane_id !== target.column.id) {
    throw new Error(`The move to ${target.column.name} did not complete.`);
  }

  if (message) void deliverMessageAfterMove(context, projectId, task.id, target.column.name, message);
  return { columnName: target.column.name };
}
