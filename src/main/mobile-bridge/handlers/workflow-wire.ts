import type { BoardTaskWorkflowWire } from '@kangentic/protocol';
import type { Task, Workflow, WorkflowSummary } from '../../../shared/types';
import { nextOnRoute, routeColumns } from '../../../shared/workflow-route';
import { WORKFLOW_REFUSALS } from '../../../shared/workflow-refusals';
import { canTaskRunAutomations } from '../../../shared/automation-manifest';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import type { IpcContext } from '../../ipc/ipc-context';
import { listWorkflowSummaries } from '../../workflows/workflow-view-service';
import { workflowOfTask } from '../../workflows/workflow-home';
import { isWorkflowTaskStopped } from '../../workflows/workflow-lock-check';

/**
 * The workflow facts of one board's tasks, as the phone draws them: the strip,
 * what each card waits for, and its lock. Read from the same summaries the
 * desktop board draws its cards from, and the lock from main's own answer on
 * whether a card has stopped, so the two cannot disagree. A board with no
 * workflow task reads nothing.
 *
 * A task on this board may belong to a workflow homed in another project; that
 * home's summaries are read once per call. A finished workflow is not in the
 * summaries (they list open ones), so its tasks get its state with no lock.
 */
export function workflowWireFacts(context: IpcContext, projectId: string, tasks: readonly Task[]): Map<string, BoardTaskWorkflowWire> {
  const facts = new Map<string, BoardTaskWorkflowWire>();
  const inWorkflows = tasks.filter((task) => task.workflow_id);
  if (inWorkflows.length === 0) return facts;

  const lanes = getProjectRepos(context, projectId).swimlanes.list();
  const summariesByHome = new Map<string, Map<string, WorkflowSummary>>();
  const finishedById = new Map<string, Workflow | null>();

  const summariesOf = (homeId: string): Map<string, WorkflowSummary> => {
    let summaries = summariesByHome.get(homeId);
    if (!summaries) {
      summaries = new Map();
      try {
        for (const summary of listWorkflowSummaries(context, homeId)) summaries.set(summary.workflow.id, summary);
      } catch {
        // The home's database will not open: its tasks here go without a strip
        // rather than failing the board. A home that is gone lists none.
      }
      summariesByHome.set(homeId, summaries);
    }
    return summaries;
  };

  const finishedWorkflow = (task: Task, workflowId: string): Workflow | null => {
    if (!finishedById.has(workflowId)) {
      let workflow: Workflow | null;
      try {
        workflow = workflowOfTask(task, projectId);
      } catch {
        workflow = null;
      }
      finishedById.set(workflowId, workflow);
    }
    return finishedById.get(workflowId) ?? null;
  };

  for (const task of inWorkflows) {
    const workflowId = task.workflow_id!;
    const homeId = task.workflow_project_id ?? projectId;
    const summary = summariesOf(homeId).get(workflowId);
    const workflow = summary?.workflow ?? finishedWorkflow(task, workflowId);
    if (!workflow) continue;
    const boardTask = summary?.boardTasks[task.id];
    const lane = lanes.find((candidate) => candidate.id === task.swimlane_id);
    const stopped = workflow.state === 'running' && lane !== undefined && isWorkflowTaskStopped(context, task, lane);
    // The phone moves a card only into this column, so a stopped card names the
    // next on its route: the move a person is waiting to make. The desktop takes
    // it anywhere but To Do.
    const gateTargetId = stopped ? nextOnRoute(lanes, task, task.swimlane_id)?.id ?? null : null;
    facts.set(task.id, {
      id: workflow.id,
      title: workflow.title,
      project_id: homeId,
      state: workflow.state,
      color_slot: workflow.color_slot,
      route: routeColumns(lanes, task).map((column) => column.id),
      waiting_for: boardTask?.waitingFor ?? [],
      // The card is locked as the desktop board locks it (`isLockedOnBoard`,
      // where a drag stays in its column): while the workflow runs and it is in
      // motion. A paused workflow's cards move by hand, and so does a card whose
      // own automations are paused.
      lock_reason: workflow.state === 'running' && !stopped && canTaskRunAutomations(task).ok
        ? WORKFLOW_REFUSALS.locked(`#${task.display_id}`, workflow.title)
        : null,
      gate_target_id: gateTargetId,
      automations_pausable: true,
    });
  }
  return facts;
}
