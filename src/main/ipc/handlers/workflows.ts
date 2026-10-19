import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { WorkflowCanvasPosition, WorkflowTaskInput } from '../../../shared/types';
import { isPlanApproval } from '../../../shared/plan-approval';
import type { IpcContext } from '../ipc-context';
import {
  deleteWorkflow,
  pauseWorkflow,
  renameWorkflow,
  resumeWorkflow,
  setWorkflowPlanApproval,
  startWorkflow,
  WorkflowRequestError,
} from '../../workflows/workflow-service';
import {
  addViewTask,
  createWorkflowForView,
  listWorkflowSummaries,
  listWorkflowSupersessions,
  readWorkflowDetail,
  removeViewTask,
  setViewLink,
  setViewPositions,
  setViewRoute,
  updatePlannedTask,
} from '../../workflows/workflow-view-service';
import {
  openWorkflowAgent,
  pauseWorkflowAgent,
  registerWorkflowAgentLifecycle,
  requireWorkflowAgentIdle,
  resumeWorkflowAgent,
} from '../../workflows/workflow-agent';

/**
 * The Workflows view's IPC. Every channel names the workflow's HOME project,
 * captured when the user acted, so a project switch mid-call cannot aim it at
 * another board. The rules live in `src/main/workflows/`; a refusal rejects
 * with a sentence written for the user (`describeIpcError` strips Electron's
 * wrapper in the renderer).
 */
export function registerWorkflowHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.WORKFLOW_LIST, (_, projectId: string) => listWorkflowSummaries(context, projectId));

  ipcMain.handle(IPC.WORKFLOW_LIST_SUPERSESSIONS, (_, projectId: string) => listWorkflowSupersessions(projectId));

  ipcMain.handle(IPC.WORKFLOW_GET, (_, projectId: string, workflowId: string) => readWorkflowDetail(context, projectId, workflowId));

  ipcMain.handle(IPC.WORKFLOW_CREATE, (_, projectId: string, sourceTaskId: string | null) =>
    createWorkflowForView(context, projectId, sourceTaskId ?? null));

  ipcMain.handle(IPC.WORKFLOW_RENAME, (_, projectId: string, workflowId: string, title: string) =>
    renameWorkflow(context, projectId, workflowId, title));

  ipcMain.handle(IPC.WORKFLOW_SET_PLAN_APPROVAL, (_, projectId: string, workflowId: string, planApproval: unknown) => {
    if (planApproval !== null && !isPlanApproval(planApproval)) {
      throw new WorkflowRequestError('Plan approval must be "automatic", "manual", or null to follow the columns.');
    }
    setWorkflowPlanApproval(context, projectId, workflowId, planApproval);
  });

  ipcMain.handle(IPC.WORKFLOW_DELETE, (_, projectId: string, workflowId: string) => {
    deleteWorkflow(context, projectId, workflowId);
  });

  ipcMain.handle(IPC.WORKFLOW_START, async (_, projectId: string, workflowId: string) => {
    requireWorkflowAgentIdle(context, workflowId);
    await startWorkflow(context, projectId, workflowId);
  });

  ipcMain.handle(IPC.WORKFLOW_PAUSE, async (_, projectId: string, workflowId: string) => {
    await pauseWorkflow(context, projectId, workflowId);
  });

  ipcMain.handle(IPC.WORKFLOW_RESUME, async (_, projectId: string, workflowId: string) => {
    await resumeWorkflow(context, projectId, workflowId);
  });

  ipcMain.handle(IPC.WORKFLOW_ADD_TASK, (_, projectId: string, workflowId: string, input: WorkflowTaskInput) => {
    requireWorkflowAgentIdle(context, workflowId);
    return addViewTask(context, projectId, workflowId, input);
  });

  ipcMain.handle(IPC.WORKFLOW_UPDATE_TASK, (_, projectId: string, workflowId: string, key: string, input: Partial<WorkflowTaskInput>) => {
    requireWorkflowAgentIdle(context, workflowId);
    updatePlannedTask(context, projectId, workflowId, key, input);
  });

  ipcMain.handle(IPC.WORKFLOW_REMOVE_TASK, (_, projectId: string, workflowId: string, key: string) => {
    requireWorkflowAgentIdle(context, workflowId);
    removeViewTask(context, projectId, workflowId, key);
  });

  ipcMain.handle(
    IPC.WORKFLOW_SET_LINK,
    (_, projectId: string, workflowId: string, blockerKey: string, blockedKey: string, linked: boolean) => {
      requireWorkflowAgentIdle(context, workflowId);
      setViewLink(context, projectId, workflowId, blockerKey, blockedKey, linked === true);
    },
  );

  ipcMain.handle(IPC.WORKFLOW_SET_ROUTE, (_, projectId: string, workflowId: string, key: string, swimlaneIds: string[]) => {
    requireWorkflowAgentIdle(context, workflowId);
    setViewRoute(context, projectId, workflowId, key, Array.isArray(swimlaneIds) ? swimlaneIds : []);
  });

  ipcMain.handle(
    IPC.WORKFLOW_SET_POSITIONS,
    (_, projectId: string, workflowId: string, positions: WorkflowCanvasPosition[] | null) => {
      // Null clears every hand-placed card, so only an explicit null may: a
      // malformed payload is refused rather than read as that.
      if (positions !== null && !Array.isArray(positions)) {
        throw new WorkflowRequestError('Card places must be a list, or null to clear them.');
      }
      setViewPositions(context, projectId, workflowId, positions);
    },
  );

  // The workflow's own agent. Not a project-scoped mutation in the
  // project-scoped-ipc sense: every call names the workflow's home project.
  registerWorkflowAgentLifecycle(context);
  ipcMain.handle(IPC.WORKFLOW_AGENT_OPEN, (_, projectId: string, workflowId: string, cols?: number, rows?: number) =>
    openWorkflowAgent(context, projectId, workflowId, { cols: gridSize(cols), rows: gridSize(rows) }));

  ipcMain.handle(IPC.WORKFLOW_AGENT_RESUME, (_, projectId: string, workflowId: string, cols?: number, rows?: number) =>
    resumeWorkflowAgent(context, projectId, workflowId, { cols: gridSize(cols), rows: gridSize(rows) }));

  ipcMain.handle(IPC.WORKFLOW_AGENT_PAUSE, async (_, _projectId: string, workflowId: string) => {
    await pauseWorkflowAgent(context, workflowId);
  });
}

/** A grid size the renderer measured, or none when it sent nothing usable. */
function gridSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
