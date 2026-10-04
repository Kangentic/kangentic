import type { Swimlane, Task } from '../../shared/types';
import { DEFAULT_AGENT } from '../../shared/types';
import { automationAgentChoice } from '../../shared/answer-agent';
import { nextOnRoute } from '../../shared/workflow-route';
import { getProjectDb } from '../db/database';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { agentRegistry } from '../agent/agent-registry';
import type { IpcContext } from '../ipc/ipc-context';
import { workflowMoveRefusal, type WorkflowMoveOrigin } from './engine/workflow-lock';

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
  const homeProjectId = task.workflow_project_id ?? args.projectId;
  let workflowTitle: string;
  let workflowState;
  try {
    const workflow = new WorkflowRepository(getProjectDb(homeProjectId)).getById(task.workflow_id);
    // A workflow that is gone leaves an ordinary task behind.
    if (!workflow) return null;
    workflowTitle = workflow.title;
    workflowState = workflow.state;
  } catch {
    return null;
  }
  const swimlanes = new SwimlaneRepository(getProjectDb(args.projectId)).list();
  const toLane = swimlanes.find((lane) => lane.id === args.toSwimlaneId) ?? null;
  const fromLane = swimlanes.find((lane) => lane.id === task.swimlane_id) ?? null;
  const byHand = args.origin === 'renderer' || args.origin === 'mobile';
  const humanGateTargetId = byHand && workflowState === 'running' && fromLane && isHumanGate(context, args.projectId, task, fromLane)
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
  const homeProjectId = task.workflow_project_id ?? projectId;
  try {
    const workflow = new WorkflowRepository(getProjectDb(homeProjectId)).getById(task.workflow_id);
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
      humanGateTargetId: null,
    });
  } catch {
    // The move path asks again inside the task lock, with the same rule.
    return null;
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
