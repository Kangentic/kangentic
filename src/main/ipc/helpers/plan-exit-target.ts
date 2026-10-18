import type { Swimlane, Task } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import type { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { applyProfileToLane } from '../../transition-engine/column-strategy';
import { nextOnRoute } from '../../../shared/workflow-route';
import { loadTaskProfile } from './task-profile';

/**
 * Where a task goes when its agent leaves plan mode in `fromSwimlaneId`: the
 * next column on its route for a workflow task (the approval finishes its
 * step), else that column's `plan_exit_target_id` folded through the task's
 * Board Profile, which can re-point it per task. Null when there is none.
 *
 * One answer for both readers: the `plan-exit` listener moves an approved plan
 * here, and the turn-end runner counts a drag here, made after the plan was
 * left, as that same plan exit. Two copies would let them disagree on a target.
 */
export function planExitTargetFor(
  context: IpcContext,
  task: Task,
  fromSwimlaneId: string,
  swimlanes: Pick<SwimlaneRepository, 'getById' | 'list'>,
  projectPath: string | null,
): Swimlane | null {
  if (task.workflow_id) return nextOnRoute(swimlanes.list(), task, fromSwimlaneId);
  const lane = applyProfileToLane(
    swimlanes.getById(fromSwimlaneId),
    loadTaskProfile(context, task, projectPath),
    swimlanes.list(),
  );
  return lane?.plan_exit_target_id ? (swimlanes.getById(lane.plan_exit_target_id) ?? null) : null;
}
