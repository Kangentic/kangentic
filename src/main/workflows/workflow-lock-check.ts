import type { Swimlane, Task } from '../../shared/types';
import { canTaskRunAutomations } from '../../shared/automation-manifest';
import { getProjectDb } from '../db/database';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { hasMoveFollowUp, hasPendingMessageDelivery, hasTurnEndGroup } from '../automations/turn-end/turn-end-passes';
import { isTurnSettled } from '../pty/turn-settled';
import { getInFlightSpawnProgress } from '../transition-engine/spawn-progress';
import type { IpcContext } from '../ipc/ipc-context';
import { workflowMoveRefusal, type WorkflowMoveOrigin } from '../../shared/workflow-lock';
import { isMoveByAPerson } from '../../shared/task-move-origin';
import { workflowOfTask } from './workflow-home';

/**
 * Gather what `workflowMoveRefusal` needs for one move, from the databases and
 * config, and ask it. Null allows the move; a string is the refusal to show.
 *
 * Cheap for an ordinary task (one field read), so every move path can call it
 * before it does anything else.
 */
export function checkWorkflowMove(
  context: IpcContext,
  args: {
    projectId: string;
    task: Task;
    toSwimlaneId: string;
    origin: WorkflowMoveOrigin;
    moverIsTaskAgent: boolean;
  },
): string | null {
  const { task } = args;
  // Falsy rather than `=== null`: a row assembled without the column carries
  // `undefined`, and that is an ordinary task too.
  if (!task.workflow_id) return null;
  let workflowTitle: string;
  let workflowState;
  try {
    const workflow = workflowOfTask(task, args.projectId);
    // A workflow that is gone, or whose home project is, leaves an ordinary task behind.
    if (!workflow) return null;
    workflowTitle = workflow.title;
    workflowState = workflow.state;
  } catch (error) {
    // Fails open on purpose. A home database that cannot be read cannot run
    // the workflow either, so nothing moves the task on, and refusing every
    // hand move would leave it stuck where it is. Logged, so the allow is
    // never silent.
    console.warn(`[WORKFLOW-LOCK] Could not read workflow ${task.workflow_id} for task ${task.id.slice(0, 8)}, so the move is allowed:`, error);
    return null;
  }
  const swimlanes = new SwimlaneRepository(getProjectDb(args.projectId)).list();
  const toLane = swimlanes.find((lane) => lane.id === args.toSwimlaneId) ?? null;
  const fromLane = swimlanes.find((lane) => lane.id === task.swimlane_id) ?? null;
  const byHand = isMoveByAPerson(args.origin);
  const taskStopped = byHand && workflowState === 'running' && fromLane !== null
    && isWorkflowTaskStopped(context, task, fromLane);
  return workflowMoveRefusal({
    displayId: task.display_id,
    workflowTitle,
    workflowState,
    origin: args.origin,
    fromSwimlaneId: task.swimlane_id,
    toSwimlaneId: args.toSwimlaneId,
    toRole: toLane?.role ?? null,
    moverIsTaskAgent: args.moverIsTaskAgent,
    taskHeld: !canTaskRunAutomations(task).ok,
    taskStopped,
  });
}

/**
 * The lock for an agent's move (`kangentic_move_task`), asked by its handler
 * before it fires the move. Only a person takes a stopped card, so this needs
 * no IPC context: only the task, its workflow and the destination.
 */
export function checkWorkflowMoveForAgent(
  projectId: string,
  task: Task,
  toSwimlaneId: string,
  moverIsTaskAgent: boolean,
): string | null {
  if (!task.workflow_id) return null;
  try {
    const workflow = workflowOfTask(task, projectId);
    if (!workflow) return null;
    const toLane = new SwimlaneRepository(getProjectDb(projectId)).getById(toSwimlaneId);
    return workflowMoveRefusal({
      displayId: task.display_id,
      workflowTitle: workflow.title,
      workflowState: workflow.state,
      origin: 'agent',
      fromSwimlaneId: task.swimlane_id,
      toSwimlaneId,
      toRole: toLane?.role ?? null,
      moverIsTaskAgent,
      taskHeld: !canTaskRunAutomations(task).ok,
      taskStopped: false,
    });
  } catch {
    // Fails open on purpose: the move path asks again inside the task lock,
    // with the same rule, and refuses there. The cost is that an agent hears
    // "Moving" for a move that is then refused, and the refusal is only logged;
    // that needs the databases to fail between the two reads.
    return null;
  }
}

/** The title of the workflow a task is in, for a refusal that names it; "its workflow" if unreadable. */
export function workflowTitleOf(task: Pick<Task, 'workflow_id' | 'workflow_project_id'>, projectId: string): string {
  if (!task.workflow_id) return 'its workflow';
  try {
    return workflowOfTask(task, projectId)?.title ?? 'its workflow';
  } catch {
    return 'its workflow';
  }
}

/**
 * The task row for the lock's pre-check, the one `handleTaskMove` asks before
 * it aborts anything. Null on any read failure: the pre-check only spares
 * in-flight work from a move that will be refused, and the check inside the
 * task lock is the one that enforces.
 */
export function readTaskForWorkflowPrecheck(projectId: string, taskId: string): Task | null {
  try {
    return new TaskRepository(getProjectDb(projectId)).getById(taskId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Has this running workflow task stopped, so a person may move it? Main's whole
 * answer, asked again under the task lock on every hand move, and read by the
 * phone. In motion, locked; stopped, the owner's (owner's decision, 2026-11-05).
 *
 * In motion: the agent is working, a turn background work holds included; it sits
 * at a permission prompt, a question or a plan approval; a turn-end pass is
 * acting on its reply; a message is on its way to it; or it is starting or
 * queued for a slot. Anything else is stopped, a task with no agent included,
 * and so is an agent that ended on `Needs owner:`, which ends its turn.
 *
 * To Do is not stopped: no agent runs there, but only the engine starts a card
 * from it, once its blockers are done. Nor is Done: moving a card out would
 * un-finish a blocker its dependents already started on.
 */
export function isWorkflowTaskStopped(context: IpcContext, task: Task, column: Swimlane): boolean {
  if (column.role === 'todo' || column.role === 'done') return false;
  const { sessionManager } = context;
  if (hasTurnEndGroup(task.id) || hasMoveFollowUp(task.id) || hasPendingMessageDelivery(task.id)) return false;
  if (context.terminalSubmitScheduler.hasPending(task.id)) return false;
  if (task.id in getInFlightSpawnProgress()) return false;
  const session = sessionManager.findLiveSessionByTaskId(task.id);
  // No live session of its own, though one may be starting.
  if (!session) return !sessionManager.hasLiveOrStartingSession(task.id);
  if (session.status === 'queued') return false;
  return isTurnSettled(sessionManager, session.id) && sessionManager.automatedKeysBlocker(session.id) === null;
}
