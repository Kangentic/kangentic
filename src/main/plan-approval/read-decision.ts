import type { PermissionMode, PlanApproval, Swimlane } from '../../shared/types';
import { canTaskRunAutomations } from '../../shared/automation-manifest';
import type { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import type { PlanApprovalDecision } from '../agent/shared/plan-approval-hook';
import { applyProfileToLane } from '../transition-engine/column-strategy';
import { getProjectRepos } from '../ipc/helpers/project-repos';
import { loadTaskProfile } from '../ipc/helpers/task-profile';
import { planExitTargetFor } from '../ipc/helpers/plan-exit-target';
import type { IpcContext } from '../ipc/ipc-context';
import { workflowOfTask } from '../workflows/workflow-home';
import { adoptLegacyPlanApproval, readTaskPlanApproval } from './workflow-plan-approval';
import { resolvePlanApprovalDecision } from './resolve-decision';

/**
 * What one refresh pass reads once and every session in it shares. The
 * effective config is a synchronous read, and a board's columns are the same
 * for every session on it, so neither is repeated per session. A workflow
 * task's plan approval is its own, read from its own route each time.
 */
export interface DecisionReadCache {
  /** By project path ('' for none). */
  globalModes: Map<string, PermissionMode>;
  /** By project id. */
  boards: Map<string, BoardColumns>;
  /**
   * Workflow ids whose legacy plan approval this pass already tried to adopt.
   * Once adopted it is one null check, but a board that will not read keeps it
   * in place, and every session of that workflow would walk every board again.
   */
  legacyAdoptionsTried: Set<string>;
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
  return { globalModes: new Map(), boards: new Map(), legacyAdoptionsTried: new Set() };
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
 *
 * A task whose automations are disabled approves nothing, unless the caller
 * sets `ignoreDisabledAutomations`. Only the pre-spawn question does: it asks
 * what the session should be able to do once the user enables them again.
 */
export function readPlanApprovalDecision(
  context: IpcContext,
  input: {
    projectId: string;
    taskId: string;
    agentCanApprove: boolean;
    bypassAvailable: boolean;
    ignoreDisabledAutomations?: boolean;
  },
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

  // A workflow task keeps or overrides its plan columns, whatever state its
  // workflow is in, so a paused workflow's task moved by hand still honours it.
  let workflowTaskValue: PlanApproval | null = null;
  const workflow = workflowOfTask(task, input.projectId);
  if (workflow) {
    // Read before the adoption: this task row was read before any copy landed.
    const legacy = workflow.plan_approval;
    if (!cache.legacyAdoptionsTried.has(workflow.id)) {
      cache.legacyAdoptionsTried.add(workflow.id);
      adoptLegacyPlanApproval(context, task.workflow_project_id ?? input.projectId, workflow);
    }
    workflowTaskValue = readTaskPlanApproval(context, input.projectId, task, legacy, lanes)?.value ?? null;
  }

  const rawTarget = planExitTargetFor(context, task, task.swimlane_id, board, projectPath);
  const target = rawTarget ? applyProfileToLane(rawTarget, profile, lanes) : null;

  const configKey = projectPath ?? '';
  const globalPermissionMode = cache.globalModes.get(configKey)
    ?? context.configManager.getEffectiveConfig(projectPath ?? undefined).agent.permissionMode;
  cache.globalModes.set(configKey, globalPermissionMode);

  const automationsDisabled = !canTaskRunAutomations(task).ok && !input.ignoreDisabledAutomations;

  return resolvePlanApprovalDecision({
    agentCanApprove: input.agentCanApprove,
    automationsDisabled,
    bypassAvailable: input.bypassAvailable,
    column,
    workflowTaskValue,
    target,
    taskPermissionMode: task.permission_mode,
    globalPermissionMode,
  });
}
