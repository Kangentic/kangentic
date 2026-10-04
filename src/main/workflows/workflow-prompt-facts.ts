import type { Swimlane, Task } from '../../shared/types';
import { doneColumn, routeColumns } from '../../shared/workflow-route';
import { getProjectDb } from '../db/database';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { TaskLinkRepository } from '../db/repositories/task-link-repository';
import type { WorkflowXmlInput } from '../agent/shared/prompt-xml';

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
    const homeProjectId = task.workflow_project_id ?? projectId;
    const homeDb = getProjectDb(homeProjectId);
    const workflow = new WorkflowRepository(homeDb).getById(task.workflow_id);
    if (!workflow) return null;
    const ownLanes = new SwimlaneRepository(getProjectDb(projectId)).list();
    const links = new TaskLinkRepository(homeDb);

    const lanesByProject = new Map<string, Swimlane[]>([[projectId, ownLanes]]);
    const describe = (otherProjectId: string, otherTaskId: string): { task: Task; column: string } | null => {
      try {
        const db = getProjectDb(otherProjectId);
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
    return {
      title: workflow.title,
      route: [...routeColumns(ownLanes, task), ...(done ? [done] : [])].map((lane) => lane.name),
      waitsFor,
      blocks,
    };
  } catch {
    return null;
  }
}
