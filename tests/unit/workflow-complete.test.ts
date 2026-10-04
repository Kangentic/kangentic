/**
 * `announceWorkflowComplete` (src/main/workflows/workflow-complete.ts): the one
 * place a finished workflow is told to the people watching, over two channels.
 *
 * - The renderer gets the `WORKFLOW_COMPLETED` push, which raises the toast and
 *   the desktop notification behind their own switches.
 * - Paired phones get a `workflow-complete` push through the mobile bridge. The
 *   bridge is optional on the context (a build or a boot where it was never
 *   constructed), so its absence must cost the renderer nothing.
 *
 * Whether the bridge's notifier is a no-op before it is attached or after it is
 * disposed is pinned where the service is, in mobile-bridge/mobile-bridge-service.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetProjectDb, mockGetById, mockSendToRenderer } = vi.hoisted(() => ({
  mockGetProjectDb: vi.fn(() => ({})),
  mockGetById: vi.fn(),
  mockSendToRenderer: vi.fn(),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: mockGetProjectDb }));
vi.mock('../../src/main/db/repositories/workflow-repository', () => ({
  WorkflowRepository: class {
    getById = mockGetById;
  },
}));
vi.mock('../../src/main/ipc/send-to-renderer', () => ({ sendToRenderer: mockSendToRenderer }));

import { announceWorkflowComplete } from '../../src/main/workflows/workflow-complete';
import { IPC } from '../../src/shared/ipc-channels';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

const mainWindow = { id: 'main-window' };

function buildContext(mobileBridgeService?: { notifyWorkflowComplete: ReturnType<typeof vi.fn> }): IpcContext {
  return { mainWindow, mobileBridgeService } as unknown as IpcContext;
}

describe('announceWorkflowComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mockGetById.mockReturnValue({ id: 'wf-1', title: 'Usage budgets' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tells the paired phones the workflow\'s project, id, stored title and task count', () => {
    const notifyWorkflowComplete = vi.fn();

    announceWorkflowComplete(buildContext({ notifyWorkflowComplete }), 'home', 'wf-1', 9);

    expect(mockGetProjectDb).toHaveBeenCalledWith('home');
    expect(mockGetById).toHaveBeenCalledWith('wf-1');
    expect(notifyWorkflowComplete).toHaveBeenCalledTimes(1);
    expect(notifyWorkflowComplete).toHaveBeenCalledWith({
      projectId: 'home',
      workflowId: 'wf-1',
      title: 'Usage budgets',
      taskCount: 9,
    });
  });

  it('tells the renderer too, with the same facts', () => {
    announceWorkflowComplete(buildContext({ notifyWorkflowComplete: vi.fn() }), 'home', 'wf-1', 9);

    expect(mockSendToRenderer).toHaveBeenCalledTimes(1);
    expect(mockSendToRenderer).toHaveBeenCalledWith(mainWindow, IPC.WORKFLOW_COMPLETED, {
      workflowId: 'wf-1',
      title: 'Usage budgets',
      taskCount: 9,
      projectId: 'home',
    });
  });

  it('does not throw when there is no mobile bridge, and the renderer is still told', () => {
    expect(() => announceWorkflowComplete(buildContext(undefined), 'home', 'wf-1', 1)).not.toThrow();

    expect(mockSendToRenderer).toHaveBeenCalledTimes(1);
    expect(mockSendToRenderer).toHaveBeenCalledWith(mainWindow, IPC.WORKFLOW_COMPLETED, expect.objectContaining({ workflowId: 'wf-1', taskCount: 1 }));
  });

  it('tells no one about a workflow that is no longer there', () => {
    mockGetById.mockReturnValue(undefined);
    const notifyWorkflowComplete = vi.fn();

    announceWorkflowComplete(buildContext({ notifyWorkflowComplete }), 'home', 'wf-gone', 3);

    expect(mockSendToRenderer).not.toHaveBeenCalled();
    expect(notifyWorkflowComplete).not.toHaveBeenCalled();
  });
});
