/**
 * The WORKFLOW_SET_POSITIONS IPC handler in ipc/handlers/workflows.ts.
 *
 * A null payload clears every hand-placed card on the canvas, so only an
 * explicit null may. A payload that is neither a list nor null (undefined from a
 * dropped argument, a string from a bad caller) is refused with a
 * WorkflowRequestError and writes nothing, rather than being read as that clear.
 *
 * Pattern: capture the function registered via ipcMain.handle and invoke it
 * directly (same approach as board-config-last-warnings-handler.test.ts). The
 * view service and the workflow agent are mocked whole, so the test observes
 * what the handler passes to `setViewPositions` and nothing else runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowCanvasPosition } from '../../src/shared/types';

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
// The real workflow service is imported for WorkflowRequestError, so the refusal's
// class is the one the handler throws. Its heavy dependencies are mocked, as in
// workflow-service.test.ts; nothing here calls into them.
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-pause', () => ({ pauseTaskSession: vi.fn() }));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: vi.fn() }));

const { registerWorkflowHandlers } = await import('../../src/main/ipc/handlers/workflows');
const { setViewPositions } = await import('../../src/main/workflows/workflow-view-service');
const { WorkflowRequestError } = await import('../../src/main/workflows/workflow-service');
const { IPC } = await import('../../src/shared/ipc-channels');

import type { IpcContext } from '../../src/main/ipc/ipc-context';

describe('the WORKFLOW_SET_POSITIONS handler', () => {
  const context = {} as IpcContext;

  beforeEach(() => {
    capturedHandlers.clear();
    vi.mocked(setViewPositions).mockClear();
    registerWorkflowHandlers(context);
  });

  /** Call the handler the way Electron does: a throw becomes a rejection. */
  async function invoke(positions: unknown): Promise<unknown> {
    const handler = capturedHandlers.get(IPC.WORKFLOW_SET_POSITIONS);
    if (!handler) throw new Error(`Handler for ${IPC.WORKFLOW_SET_POSITIONS} was not registered`);
    return handler(null, 'home', 'workflow-1', positions);
  }

  it.each([
    ['undefined', undefined],
    ['a string', 'clear'],
    ['an object that is not a list', { key: 'api', x: 10, y: 20 }],
    ['a number', 0],
  ])('refuses %s with a WorkflowRequestError and writes nothing', async (_label, payload) => {
    const refusal = invoke(payload);

    await expect(refusal).rejects.toThrow(WorkflowRequestError);
    await expect(refusal).rejects.toThrow(/must be a list/);
    expect(setViewPositions).not.toHaveBeenCalled();
  });

  it('clears every card place for an explicit null', async () => {
    await invoke(null);

    expect(setViewPositions).toHaveBeenCalledTimes(1);
    expect(setViewPositions).toHaveBeenCalledWith(context, 'home', 'workflow-1', null);
  });

  it('passes a list of places through as it arrived', async () => {
    const positions: WorkflowCanvasPosition[] = [
      { key: 'api', x: 10, y: 20 },
      { key: 'ui', x: 300, y: 20 },
    ];

    await invoke(positions);

    expect(setViewPositions).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setViewPositions).mock.calls[0][3]).toBe(positions);
    expect(setViewPositions).toHaveBeenCalledWith(context, 'home', 'workflow-1', positions);
  });

  it('passes an empty list through as a list, which is not a clear', async () => {
    await invoke([]);

    expect(setViewPositions).toHaveBeenCalledWith(context, 'home', 'workflow-1', []);
  });
});
