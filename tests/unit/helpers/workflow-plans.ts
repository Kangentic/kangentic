/**
 * A workflow planned across two boards, shared by the suites that read which
 * board a task is on. Each suite imports the workflow service after its own
 * module mocks, so it passes that service in rather than this file importing it.
 */
import type { IpcContext } from '../../../src/main/ipc/ipc-context';
import type * as WorkflowService from '../../../src/main/workflows/workflow-service';
import type { Workflow } from '../../../src/shared/types';

type PlanningService = Pick<typeof WorkflowService, 'createWorkflow' | 'savePlan'>;

/**
 * api and ui on the home board, phone on the `kangentic-mobile` board. The phone
 * task blocks api, and api blocks ui.
 */
export function planAcrossBoards(service: PlanningService, context: IpcContext, homeProjectId = 'home'): Workflow {
  const workflow = service.createWorkflow(homeProjectId, {});
  service.savePlan(context, homeProjectId, workflow.id, {
    title: 'Usage budgets',
    tasks: [
      { key: 'api', title: 'Budgets API' },
      { key: 'phone', title: 'Budgets on the phone', project: 'kangentic-mobile' },
      { key: 'ui', title: 'Budgets UI' },
    ],
    links: [{ blocker: 'phone', blocked: 'api' }, { blocker: 'api', blocked: 'ui' }],
  });
  return workflow;
}

/** The task with this title in a workflow's read model, or a thrown error naming it. */
export function taskTitled(view: WorkflowService.WorkflowView, title: string): WorkflowService.WorkflowTaskView {
  const task = view.tasks.find((candidate) => candidate.title === title);
  if (!task) throw new Error(`No task "${title}" in the workflow.`);
  return task;
}
