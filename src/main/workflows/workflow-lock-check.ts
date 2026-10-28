import type { Swimlane, Task } from '../../shared/types';
import { DEFAULT_AGENT } from '../../shared/types';
import { automationAgentChoice } from '../../shared/answer-agent';
import { canTaskRunAutomations } from '../../shared/automation-manifest';
import { nextOnRoute } from '../../shared/workflow-route';
import { getProjectDb } from '../db/database';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { agentRegistry } from '../agent/agent-registry';
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
  // A gate is a column of the route a started task sits in. To Do runs no
  // agent either, but it is the queue: only the engine starts a task from it,
  // once its blockers are done, so a hand never drags one out. The board's
  // lock reads the same rule (`humanGateExit` in workflow-view-service.ts asks
  // only for a started task).
  const humanGateTargetId = byHand && workflowState === 'running' && fromLane
    && fromLane.role !== 'todo' && fromLane.role !== 'done'
    && isHumanGate(context, args.projectId, task, fromLane)
    ? nextOnRoute(swimlanes, task, fromLane.id)?.id ?? null
    : null;
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
    humanGateTargetId,
  });
}

/**
 * The lock for an agent's move (`kangentic_move_task`), asked by its handler
 * before it fires the move. An agent never drags out of a human gate, so this
 * needs no IPC context: only the task, its workflow and the destination.
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
      humanGateTargetId: null,
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
 * A column whose work no agent can judge, so a person moves the task on: no
 * agent works there, its agent does not report when a turn ends, or no
 * Automation agent is set up to judge the work. The check reads config only
 * (whether an agent is chosen), never probes a CLI, so a drag is never slowed.
 */
export function isHumanGate(context: IpcContext, projectId: string, task: Task, column: Swimlane): boolean {
  if (!column.auto_spawn) return true;
  const config = context.configManager.load();
  if (!automationAgentChoice(config.automation).agent) return true;
  const projectDefault = context.projectRepo.getById(projectId)?.default_agent ?? null;
  const agentName = task.agent_override ?? column.agent_override ?? projectDefault ?? DEFAULT_AGENT;
  const adapter = agentRegistry.get(agentName);
  return adapter ? !adapter.runtime.reportsTurnEnd : true;
}
