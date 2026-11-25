/**
 * #1211: the two IPC channels behind Add blocker's cards from outside the
 * workflow (registerWorkflowHandlers in src/main/ipc/handlers/workflows.ts).
 *
 * The service rules are pinned against real SQLite in workflow-view-service.test.ts
 * and workflow-join-where-it-is.test.ts, and the UI tier reaches these channels only
 * through the mock bridge. So nothing else runs the handlers themselves: that
 * WORKFLOW_ADD_CARD_BLOCKER waits for the workflow's agent to be idle before it
 * changes the workflow, as WORKFLOW_ADD_TASK, WORKFLOW_SET_LINK and
 * WORKFLOW_SET_ROUTE do, and that both channels
 * hand the service their arguments in the order it takes them. Five string
 * arguments in a row swap without a type error.
 *
 * Pattern: capture the function registered via ipcMain.handle and invoke it
 * directly, as workflow-handlers-set-positions.test.ts does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/main/workflows/workflow-view-service', () => ({
  addCardBlocker: vi.fn(),
  addViewTask: vi.fn(),
  createWorkflowForView: vi.fn(),
  listJoinCandidates: vi.fn(),
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
vi.mock('../../src/main/workflows/workflow-agent', () => ({
  endWorkflowAgent: vi.fn(),
  openWorkflowAgent: vi.fn(),
  pauseWorkflowAgent: vi.fn(),
  registerWorkflowAgentLifecycle: vi.fn(),
  requireWorkflowAgentIdle: vi.fn(),
  resumeWorkflowAgent: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-service', () => ({
  deleteNeverStartedTasks: vi.fn(),
  deleteWorkflow: vi.fn(),
  pauseWorkflow: vi.fn(),
  renameWorkflow: vi.fn(),
  resumeWorkflow: vi.fn(),
  startWorkflow: vi.fn(),
  WorkflowRequestError: class WorkflowRequestError extends Error {},
}));

const { registerWorkflowHandlers } = await import('../../src/main/ipc/handlers/workflows');
const { addCardBlocker, listJoinCandidates } = await import('../../src/main/workflows/workflow-view-service');
const { requireWorkflowAgentIdle } = await import('../../src/main/workflows/workflow-agent');
const { IPC } = await import('../../src/shared/ipc-channels');

import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { WorkflowJoinCandidate } from '../../src/shared/types';

const context = {} as IpcContext;

/** Call a channel's handler the way Electron does: a throw becomes a rejection. */
async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = capturedHandlers.get(channel);
  if (!handler) throw new Error(`Handler for ${channel} was not registered`);
  return handler(null, ...args);
}

describe('the Add blocker channels for a card outside the workflow', () => {
  beforeEach(() => {
    capturedHandlers.clear();
    vi.mocked(addCardBlocker).mockReset();
    vi.mocked(listJoinCandidates).mockReset();
    vi.mocked(requireWorkflowAgentIdle).mockReset();
    registerWorkflowHandlers(context);
  });

  it('WORKFLOW_ADD_CARD_BLOCKER checks the workflow agent is idle, then adds the card with every argument in place', async () => {
    await invoke(IPC.WORKFLOW_ADD_CARD_BLOCKER, 'home', 'workflow-1', 'release-key', 'mobile', 'card-task-id');

    expect(requireWorkflowAgentIdle).toHaveBeenCalledWith(context, 'workflow-1');
    expect(addCardBlocker).toHaveBeenCalledTimes(1);
    expect(addCardBlocker).toHaveBeenCalledWith(context, 'home', 'workflow-1', 'release-key', 'mobile', 'card-task-id');
    expect(vi.mocked(requireWorkflowAgentIdle).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(addCardBlocker).mock.invocationCallOrder[0]);
  });

  it('WORKFLOW_ADD_CARD_BLOCKER rejects with the agent\'s refusal and takes no card in while the workflow agent is busy', async () => {
    vi.mocked(requireWorkflowAgentIdle).mockImplementation(() => {
      throw new Error('The workflow agent is changing this workflow. Wait for it to finish.');
    });

    await expect(invoke(IPC.WORKFLOW_ADD_CARD_BLOCKER, 'home', 'workflow-1', 'release-key', 'mobile', 'card-task-id'))
      .rejects.toThrow('Wait for it to finish');
    expect(addCardBlocker).not.toHaveBeenCalled();
  });

  it('WORKFLOW_LIST_JOIN_CANDIDATES reads the board it names and answers with the service\'s list', async () => {
    const candidates: WorkflowJoinCandidate[] = [{
      projectId: 'mobile', taskId: 'card-task-id', displayId: 12, title: 'Bump the protocol',
      place: 'working', column: { name: 'Executing', color: null, icon: null },
    }];
    vi.mocked(listJoinCandidates).mockReturnValue(candidates);

    const response = await invoke(IPC.WORKFLOW_LIST_JOIN_CANDIDATES, 'home', 'workflow-1', 'mobile');

    expect(listJoinCandidates).toHaveBeenCalledWith(context, 'home', 'workflow-1', 'mobile');
    expect(response).toBe(candidates);
  });
});
