import type { PermissionMode, PlanApproval, Swimlane } from '../../shared/types';
import type { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import type { PlanApprovalDecision } from '../agent/shared/plan-approval-hook';
import { applyProfileToLane } from '../transition-engine/column-strategy';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { loadTaskProfile } from '../ipc/helpers/task-profile';
import { planExitTargetFor } from '../ipc/helpers/plan-exit-target';
import type { IpcContext } from '../ipc/ipc-context';
import { workflowOfTask } from '../workflows/workflow-home';
import { readWorkflowPlanApproval } from './workflow-plan-approval';
import { resolvePlanApprovalDecision } from './resolve-decision';

/**
 * What one refresh pass reads once and every session in it shares. A running
 * workflow's derived value walks every project's database, the effective
 * config is a synchronous read, and a board's columns are the same for every
 * session on it, so none of them is repeated per session.
 */
export interface DecisionReadCache {
  /** By workflow id. */
  workflowValues: Map<string, PlanApproval>;
  /** By project path ('' for none). */
  globalModes: Map<string, PermissionMode>;
  /** By project id. */
  boards: Map<string, BoardColumns>;
}

/**
 * One board's columns, read once per pass. `getById` and `list` are the
 * repository methods `planExitTargetFor` calls.
 */
interface BoardColumns {
  projectPath: string | null;
  getById(id: string): Swimlane | undefined;
  list(): Swimlane[];
}

export function newDecisionReadCache(): DecisionReadCache {
  return { workflowValues: new Map(), globalModes: new Map(), boards: new Map() };
}

function boardColumnsOf(
  context: IpcContext,
  projectId: string,
  swimlanes: Pick<SwimlaneRepository, 'list'>,
  cache: DecisionReadCache,
): BoardColumns {
  const cached = cache.boards.get(projectId);
  if (cached) return cached;
  const lanes = swimlanes.list();
  const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
  const board: BoardColumns = {
    projectPath: context.projectRepo.getById(projectId)?.path ?? null,
    getById: (id) => lanesById.get(id),
    list: () => lanes,
  };
  cache.boards.set(projectId, board);
  return board;
}

/**
 * The decision for one session, read from the board as it is now.
 *
 * The task comes from the session's OWN task id, never from
 * `tasks.getBySessionId`: a session that has just spawned is written before the
 * task row points at it. Null when there is nothing to decide for (the task is
 * gone or archived, or its board will not read), which the writer stores as a
 * decision that approves nothing.
 */
export function readPlanApprovalDecision(
  context: IpcContext,
  input: { projectId: string; taskId: string; agentCanApprove: boolean; bypassAvailable: boolean },
  cache: DecisionReadCache = newDecisionReadCache(),
): PlanApprovalDecision | null {
  const { tasks, swimlanes } = getProjectRepos(context, input.projectId);
  const task = tasks.getById(input.taskId);
  if (!task || task.archived_at) return null;
  const board = boardColumnsOf(context, input.projectId, swimlanes, cache);
  const { projectPath } = board;
  const lanes = board.list();
  const profile = loadTaskProfile(context, task, projectPath);
  const column = applyProfileToLane(board.getById(task.swimlane_id), profile, lanes);
  if (!column) return null;

  let runningWorkflowValue: PlanApproval | null = null;
  const workflow = workflowOfTask(task, input.projectId);
  if (workflow?.state === 'running') {
    runningWorkflowValue = cache.workflowValues.get(workflow.id)
      ?? readWorkflowPlanApproval(context, task.workflow_project_id ?? input.projectId, workflow).value;
    cache.workflowValues.set(workflow.id, runningWorkflowValue);
  }

  const rawTarget = planExitTargetFor(context, task, task.swimlane_id, board, projectPath);
  const target = rawTarget ? applyProfileToLane(rawTarget, profile, lanes) : null;

  const configKey = projectPath ?? '';
  const globalPermissionMode = cache.globalModes.get(configKey)
    ?? context.configManager.getEffectiveConfig(projectPath ?? undefined).agent.permissionMode;
  cache.globalModes.set(configKey, globalPermissionMode);

  return resolvePlanApprovalDecision({
    agentCanApprove: input.agentCanApprove,
    bypassAvailable: input.bypassAvailable,
    column,
    runningWorkflowValue,
    target,
    taskPermissionMode: task.permission_mode,
    globalPermissionMode,
  });
}
