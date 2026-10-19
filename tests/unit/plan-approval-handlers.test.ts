/**
 * The WORKFLOW_SET_PLAN_APPROVAL IPC handler in ipc/handlers/workflows.ts.
 *
 * A workflow's plan approval is "automatic", "manual", or null (follow the plan
 * columns). Null is a real answer, so only an explicit null may stand for it: a
 * payload that is none of the three (a typo, a wrong case, a dropped argument
 * arriving as undefined, a number from a bad caller) is refused with a
 * WorkflowRequestError and writes nothing, rather than being stored or read as
 * "follow the columns".
 *
 * Pattern: capture the function registered via ipcMain.handle and invoke it
 * directly (same approach as workflow-handlers-set-positions.test.ts). The real
 * workflow service is loaded so the refusal's class is the one the handler
 * throws; only `setWorkflowPlanApproval` is replaced, so the test observes
 * exactly what the handler hands to it.
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
  addViewTask: vi.fn(),
  createWorkflowForView: vi.fn(),
  listWorkflowSummaries: vi.fn(),
  listWorkflowSupersessions: vi.fn(),
  readWorkflowDetail: vi.fn(),
  removeViewTask: vi.fn(),
  setViewLink: vi.fn(),
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
// The real service module, with only the write replaced. Its heavy dependencies
// are mocked as in workflow-service.test.ts; nothing here calls into them.
vi.mock('../../src/main/workflows/workflow-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-service')>()),
  setWorkflowPlanApproval: vi.fn(),
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));

const { registerWorkflowHandlers } = await import('../../src/main/ipc/handlers/workflows');
const { setWorkflowPlanApproval, WorkflowRequestError } = await import('../../src/main/workflows/workflow-service');
const { IPC } = await import('../../src/shared/ipc-channels');

import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('the WORKFLOW_SET_PLAN_APPROVAL handler', () => {
  const context = {} as IpcContext;

  beforeEach(() => {
    capturedHandlers.clear();
    vi.mocked(setWorkflowPlanApproval).mockClear();
    registerWorkflowHandlers(context);
  });

  /** Call the handler the way Electron does: a throw becomes a rejection. */
  async function invoke(planApproval: unknown): Promise<unknown> {
    const handler = capturedHandlers.get(IPC.WORKFLOW_SET_PLAN_APPROVAL);
    if (!handler) throw new Error(`Handler for ${IPC.WORKFLOW_SET_PLAN_APPROVAL} was not registered`);
    return handler(null, 'home', 'workflow-1', planApproval);
  }

  it.each([
    ['an unknown word', 'maybe'],
    ['the right word in the wrong case', 'AUTOMATIC'],
    ['an empty string', ''],
    ['undefined, a dropped argument', undefined],
    ['a number', 42],
    ['an object', { value: 'automatic' }],
  ])('refuses %s with a WorkflowRequestError and writes nothing', async (_label, payload) => {
    const refusal = invoke(payload);

    await expect(refusal).rejects.toThrow(WorkflowRequestError);
    await expect(refusal).rejects.toThrow(/"automatic", "manual", or null/);
    expect(setWorkflowPlanApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['automatic', 'automatic'],
    ['manual', 'manual'],
    ['null, which follows the plan columns', null],
  ])('passes %s through to the service as it arrived', async (_label, payload) => {
    await invoke(payload);

    expect(setWorkflowPlanApproval).toHaveBeenCalledTimes(1);
    expect(setWorkflowPlanApproval).toHaveBeenCalledWith(context, 'home', 'workflow-1', payload);
  });
});
