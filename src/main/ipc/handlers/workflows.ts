import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import type { WorkflowCanvasPosition, WorkflowTaskInput } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';
import {
  deleteWorkflow,
  pauseWorkflow,
  renameWorkflow,
  resumeWorkflow,
  startWorkflow,
} from '../../workflows/workflow-service';
import {
  addViewTask,
  createWorkflowForView,
  listWorkflowSummaries,
  readWorkflowDetail,
  removeViewTask,
  setViewLink,
  setViewPositions,
  setViewRoute,
  updatePlannedTask,
} from '../../workflows/workflow-view-service';

/**
 * The Workflows view's IPC. Every channel names the workflow's HOME project,
 * captured when the user acted, so a project switch mid-call cannot aim it at
 * another board. The rules live in `src/main/workflows/`; a refusal rejects
 * with a sentence written for the user (`describeIpcError` strips Electron's
 * wrapper in the renderer).
 */
export function registerWorkflowHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.WORKFLOW_LIST, (_, projectId: string) => listWorkflowSummaries(context, projectId));

  ipcMain.handle(IPC.WORKFLOW_GET, (_, projectId: string, workflowId: string) => readWorkflowDetail(context, projectId, workflowId));

  ipcMain.handle(IPC.WORKFLOW_CREATE, (_, projectId: string, sourceTaskId: string | null) =>
    createWorkflowForView(context, projectId, sourceTaskId ?? null));

  ipcMain.handle(IPC.WORKFLOW_RENAME, (_, projectId: string, workflowId: string, title: string) =>
    renameWorkflow(projectId, workflowId, title));

  ipcMain.handle(IPC.WORKFLOW_DELETE, (_, projectId: string, workflowId: string) => {
    deleteWorkflow(context, projectId, workflowId);
  });

  ipcMain.handle(IPC.WORKFLOW_START, async (_, projectId: string, workflowId: string) => {
    await startWorkflow(context, projectId, workflowId);
  });

  ipcMain.handle(IPC.WORKFLOW_PAUSE, async (_, projectId: string, workflowId: string) => {
    await pauseWorkflow(context, projectId, workflowId);
  });

  ipcMain.handle(IPC.WORKFLOW_RESUME, async (_, projectId: string, workflowId: string) => {
    await resumeWorkflow(context, projectId, workflowId);
  });

  ipcMain.handle(IPC.WORKFLOW_ADD_TASK, (_, projectId: string, workflowId: string, input: WorkflowTaskInput) =>
    addViewTask(context, projectId, workflowId, input));

  ipcMain.handle(IPC.WORKFLOW_UPDATE_TASK, (_, projectId: string, workflowId: string, key: string, input: Partial<WorkflowTaskInput>) => {
    updatePlannedTask(context, projectId, workflowId, key, input);
  });

  ipcMain.handle(IPC.WORKFLOW_REMOVE_TASK, (_, projectId: string, workflowId: string, key: string) => {
    removeViewTask(context, projectId, workflowId, key);
  });

  ipcMain.handle(
    IPC.WORKFLOW_SET_LINK,
    (_, projectId: string, workflowId: string, blockerKey: string, blockedKey: string, linked: boolean) => {
      setViewLink(context, projectId, workflowId, blockerKey, blockedKey, linked === true);
    },
  );

  ipcMain.handle(IPC.WORKFLOW_SET_ROUTE, (_, projectId: string, workflowId: string, key: string, swimlaneIds: string[]) => {
    setViewRoute(context, projectId, workflowId, key, Array.isArray(swimlaneIds) ? swimlaneIds : []);
  });

  ipcMain.handle(
    IPC.WORKFLOW_SET_POSITIONS,
    (_, projectId: string, workflowId: string, positions: WorkflowCanvasPosition[] | null) => {
      setViewPositions(context, projectId, workflowId, Array.isArray(positions) ? positions : null);
    },
  );
}
