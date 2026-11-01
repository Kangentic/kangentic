import type { Swimlane, Task } from '../../shared/types';
import { doneColumn, nextOnRoute, routeColumns } from '../../shared/workflow-route';
import { getExistingProjectDb, getProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { TaskLinkRepository } from '../db/repositories/task-link-repository';
import type { WorkflowXmlInput } from '../agent/shared/prompt-xml';
import { applyProfileToLane } from '../transition-engine/column-strategy';
import { resolveSessionTarget } from '../transition-engine/session-isolation';
import { loadTaskProfile } from '../ipc/helpers/task-profile';
import { workflowRuntimeContext } from './workflow-runtime';

/**
 * Read what `{{workflow_xml}}` tells a workflow task's agent: its workflow's
 * name, its route, the tasks it built on, and the tasks waiting on it. Null for
 * an ordinary task (one field read), which resolves the variable empty, so the
 * default spawn prompt is unchanged for every task outside a workflow.
 *
 * Read by the caller and passed into the template context, so the resolvers
 * stay pure functions of their context. Never throws: a read that fails
 * leaves the block out rather than failing a spawn.
 */
export function readWorkflowPromptFacts(task: Task, projectId: string | null): WorkflowXmlInput | null {
  if (!task.workflow_id || !projectId) return null;
  try {
    // The home and each link's far end are ids stored in a task or a link, so
    // either can name a project deleted since: read, never created again.
    const homeDb = getExistingProjectDb(task.workflow_project_id ?? projectId);
    if (!homeDb) return null;
    const workflow = new WorkflowRepository(homeDb).getById(task.workflow_id);
    if (!workflow) return null;
    const ownLanes = new SwimlaneRepository(getProjectDb(projectId)).list();
    const links = new TaskLinkRepository(homeDb);

    const lanesByProject = new Map<string, Swimlane[]>([[projectId, ownLanes]]);
    const describe = (otherProjectId: string, otherTaskId: string): { task: Task; column: string } | null => {
      try {
        const db = getExistingProjectDb(otherProjectId);
        if (!db) return null;
        const other = new TaskRepository(db).getById(otherTaskId);
        if (!other) return null;
        let lanes = lanesByProject.get(otherProjectId);
        if (!lanes) {
          lanes = new SwimlaneRepository(db).list();
          lanesByProject.set(otherProjectId, lanes);
        }
        const lane = lanes.find((candidate) => candidate.id === other.swimlane_id);
        const column = lane?.name ?? (other.archived_at ? doneColumn(lanes)?.name : null) ?? 'another column';
        return { task: other, column };
      } catch {
        return null;
      }
    };

    const waitsFor = links.listBlockersOf(task.id).flatMap((link) => {
      const found = describe(link.blocker_project_id, link.blocker_task_id);
      return found
        ? [{ number: found.task.display_id, title: found.task.title, column: found.column, branch: found.task.branch_name, prUrl: found.task.pr_url }]
        : [];
    });
    const blocks = links.listBlockedBy(task.id).flatMap((link) => {
      const found = describe(link.blocked_project_id, link.blocked_task_id);
      return found ? [{ number: found.task.display_id, title: found.task.title, column: found.column }] : [];
    });

    // The route ends in the board's Done column, by whatever name this board
    // gives it.
    const done = doneColumn(ownLanes);
    // A plan column's approval moves a workflow task to the next column on its
    // route (`planExitTargetFor`), never to the column's own plan exit target.
    const current = asTaskRunsIt(ownLanes.find((lane) => lane.id === task.swimlane_id) ?? null, task, projectId, ownLanes);
    const planExitTo = current?.permission_mode === 'plan' ? nextOnRoute(ownLanes, task, current.id)?.name ?? null : null;
    const route = routeColumns(ownLanes, task);
    // Task #952: which columns run in a conversation of their own, as the task
    // runs them, so an earlier column knows a later one continues its chat.
    const ownConversation = route
      .filter((lane) => resolveSessionTarget(lane.id === current?.id ? current : asTaskRunsIt(lane, task, projectId, ownLanes)) === 'isolated')
      .map((lane) => lane.name);
    return {
      title: workflow.title,
      route: [...route, ...(done ? [done] : [])].map((lane) => lane.name),
      column: current?.name ?? null,
      planExitTo,
      ownConversation,
      waitsFor,
      blocks,
    };
  } catch {
    return null;
  }
}

/**
 * The task's column as the task runs it: its Board Profile folded in, as the
 * spawn and the plan approval read it (`workflow-plan-approval.ts`), so a
 * profile that turns plan mode on or off for this task is what the block says.
 * The column as stored when the task has no profile, or before the app's
 * context is set.
 */
function asTaskRunsIt(lane: Swimlane | null, task: Task, projectId: string, lanes: Swimlane[]): Swimlane | null {
  const context = workflowRuntimeContext();
  if (!lane || !context || !task.profile_id) return lane;
  const projectPath = context.projectRepo.getById(projectId)?.path ?? null;
  return applyProfileToLane(lane, loadTaskProfile(context, task, projectPath), lanes) ?? lane;
}
