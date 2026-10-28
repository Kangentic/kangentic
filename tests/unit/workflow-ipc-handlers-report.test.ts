/**
 * The Workflows view's Pause and Resume channels (registerWorkflowHandlers in
 * src/main/ipc/handlers/workflows.ts).
 *
 * The service answers with the refreshed workflow AND the per-agent report. The
 * channel's contract (WorkflowPauseReport / WorkflowResumeReport) is the report
 * alone: the renderer re-reads the workflow through its own change push, so the
 * handler must strip `workflow` rather than send a whole workflow row across
 * IPC on every click. Both handlers also name who asked, for the service's log.
 *
 * Mock strategy mirrors task-resolve-pr-no-project.test.ts: replace every module
 * the handler file imports with a plain factory so the real service graph never
 * loads, capture the ipcMain.handle registration for each channel, and invoke
 * it directly (no Electron, no IPC transport).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}));

const service = vi.hoisted(() => ({
  pauseWorkflow: vi.fn(),
  resumeWorkflow: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-service', () => ({
  deleteWorkflow: vi.fn(),
  pauseWorkflow: service.pauseWorkflow,
  renameWorkflow: vi.fn(),
  resumeWorkflow: service.resumeWorkflow,
  startWorkflow: vi.fn(),
  WorkflowRequestError: class WorkflowRequestError extends Error {},
}));

vi.mock('../../src/main/workflows/workflow-view-service', () => ({
  addViewTask: vi.fn(),
  createWorkflowForView: vi.fn(),
  listWorkflowSummaries: vi.fn(),
  listWorkflowSupersessions: vi.fn(),
  readWorkflowDetail: vi.fn(),
  removeViewTask: vi.fn(),
  setViewLink: vi.fn(),
  setViewPlanApproval: vi.fn(),
  setViewPositions: vi.fn(),
  setViewRoute: vi.fn(),
  updatePlannedTask: vi.fn(),
}));

// registerWorkflowAgentLifecycle runs at registration, so it must exist here.
vi.mock('../../src/main/workflows/workflow-agent', () => ({
  openWorkflowAgent: vi.fn(),
  pauseWorkflowAgent: vi.fn(),
  registerWorkflowAgentLifecycle: vi.fn(),
  requireWorkflowAgentIdle: vi.fn(),
  resumeWorkflowAgent: vi.fn(),
}));

import { ipcMain } from 'electron';
import { registerWorkflowHandlers } from '../../src/main/ipc/handlers/workflows';
import { IPC } from '../../src/shared/ipc-channels';
import type { WorkflowPauseReport, WorkflowResumeReport } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const context = {} as unknown as IpcContext;

/** The function registered for `channel` through ipcMain.handle. */
function findHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const handleMock = vi.mocked(ipcMain.handle);
  const registration = handleMock.mock.calls.find((call) => call[0] === channel);
  if (!registration) throw new Error(`No ipcMain.handle registration found for channel "${channel}"`);
  return registration[1] as unknown as (...args: unknown[]) => Promise<unknown>;
}

describe('Workflows view Pause and Resume channels', () => {
  const workflow = { id: 'wf-1', title: 'Usage budgets', state: 'paused' };
  const failed = [{ projectId: 'proj-2', taskId: 't-917', displayId: 917 }];

  beforeEach(() => {
    vi.clearAllMocks();
    registerWorkflowHandlers(context);
  });

  it('WORKFLOW_PAUSE answers with the pause report alone, and tells the service the Workflows view asked', async () => {
    service.pauseWorkflow.mockResolvedValue({ workflow, paused: 2, notLive: 1, failed });

    const response = await findHandler(IPC.WORKFLOW_PAUSE)({}, 'proj-1', 'wf-1');

    expect(service.pauseWorkflow).toHaveBeenCalledTimes(1);
    expect(service.pauseWorkflow).toHaveBeenCalledWith(context, 'proj-1', 'wf-1', 'the Workflows view');
    const expected: WorkflowPauseReport = { paused: 2, notLive: 1, failed };
    expect(response).toStrictEqual(expected);
    expect(response).not.toHaveProperty('workflow');
  });

  it('WORKFLOW_RESUME answers with the resume report alone, and tells the service the Workflows view asked', async () => {
    service.resumeWorkflow.mockResolvedValue({ workflow, resumed: 1, started: 2, alreadyRunning: 3, failed });

    const response = await findHandler(IPC.WORKFLOW_RESUME)({}, 'proj-1', 'wf-1');

    expect(service.resumeWorkflow).toHaveBeenCalledTimes(1);
    expect(service.resumeWorkflow).toHaveBeenCalledWith(context, 'proj-1', 'wf-1', 'the Workflows view');
    const expected: WorkflowResumeReport = { resumed: 1, started: 2, alreadyRunning: 3, failed };
    expect(response).toStrictEqual(expected);
    expect(response).not.toHaveProperty('workflow');
  });

  it('a refusal from the service rejects the channel with its own error, so the view can show the sentence', async () => {
    service.pauseWorkflow.mockRejectedValue(new Error('"Usage budgets" is paused, so there is nothing to pause.'));
    service.resumeWorkflow.mockRejectedValue(new Error('"Usage budgets" is running, not paused.'));

    await expect(findHandler(IPC.WORKFLOW_PAUSE)({}, 'proj-1', 'wf-1')).rejects.toThrow('nothing to pause');
    await expect(findHandler(IPC.WORKFLOW_RESUME)({}, 'proj-1', 'wf-1')).rejects.toThrow('not paused');
  });
});
