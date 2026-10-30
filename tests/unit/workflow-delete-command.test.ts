/**
 * kangentic_delete_workflow (`handleDeleteWorkflow`): with `deleteNeverStarted`
 * it also deletes the started workflow's tasks that never started, and its
 * reply names the tasks it kept and the ones it deleted, a task on another
 * board with its board, since task numbers count per board.
 *
 * The service is doubled: which tasks never started, and how each is deleted,
 * are pinned in workflow-service.test.ts on real SQLite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const service = vi.hoisted(() => ({
  resolveWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  deleteNeverStartedTasks: vi.fn(),
}));
vi.mock('../../src/main/workflows/workflow-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-service')>()),
  resolveWorkflow: service.resolveWorkflow,
  deleteWorkflow: service.deleteWorkflow,
  deleteNeverStartedTasks: service.deleteNeverStartedTasks,
}));
vi.mock('../../src/main/workflows/workflow-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/workflows/workflow-runtime')>()),
  requireWorkflowRuntimeContext: () => ({}),
}));

import { commandHandlers } from '../../src/main/agent/commands';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { ReleasedWorkflowTask } from '../../src/main/workflows/workflow-service';

const context = { projectId: 'home' } as unknown as CommandContext;
const started = { id: 'wf-1', title: 'Usage budgets', state: 'running' };

function released(displayId: number, neverStarted: boolean, board: string | null = null): ReleasedWorkflowTask {
  return { projectId: board ? 'mobile' : 'home', taskId: `task-${displayId}`, displayId, board, neverStarted };
}

describe('kangentic_delete_workflow', () => {
  const ran = released(12, false);
  const fresh = released(14, true);
  const phone = released(3, true, 'kangentic-mobile');

  beforeEach(() => {
    vi.clearAllMocks();
    service.resolveWorkflow.mockReturnValue(started);
    service.deleteWorkflow.mockReturnValue({ workflow: started, released: [ran, fresh, phone] });
  });

  it('keeps every unfinished task when not asked, and names them', async () => {
    const response = await commandHandlers.delete_workflow({ workflow: 'Usage budgets' }, context);

    expect(service.deleteNeverStartedTasks).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      success: true,
      message: 'Deleted "Usage budgets". #12, #14 and "kangentic-mobile" #3 stay where they are, as ordinary tasks.',
    });
  });

  it('names the tasks it kept and the ones it deleted when asked to delete the ones that never started', async () => {
    service.deleteNeverStartedTasks.mockResolvedValue({ deleted: [fresh, phone], kept: [ran], failed: [] });

    const response = await commandHandlers.delete_workflow({ workflow: 'Usage budgets', deleteNeverStarted: true }, context);

    expect(service.deleteNeverStartedTasks).toHaveBeenCalledWith(expect.anything(), [ran, fresh, phone]);
    expect(response).toMatchObject({
      success: true,
      message: 'Deleted "Usage budgets". #12 stays where it is, as an ordinary task. Deleted #14 and "kangentic-mobile" #3, which never started.',
      data: {
        kept: [{ taskId: 'task-12', displayId: 12, projectId: 'home', board: null }],
        deleted: [
          { taskId: 'task-14', displayId: 14, projectId: 'home', board: null },
          { taskId: 'task-3', displayId: 3, projectId: 'mobile', board: 'kangentic-mobile' },
        ],
        failed: [],
      },
    });
  });

  it('names a task it could not delete, which stays in To Do', async () => {
    service.deleteNeverStartedTasks.mockResolvedValue({
      deleted: [phone], kept: [ran], failed: [{ ...fresh, reason: 'worktree removal timed out' }],
    });

    const response = await commandHandlers.delete_workflow({ workflow: 'Usage budgets', deleteNeverStarted: true }, context);

    expect(response.success).toBe(true);
    expect(response.message).toContain('Could not delete #14 (worktree removal timed out). It stays in To Do as an ordinary task.');
  });

  it('refuses a deleteNeverStarted that is not true or false before deleting anything', async () => {
    const response = await commandHandlers.delete_workflow({ workflow: 'Usage budgets', deleteNeverStarted: 'yes' }, context);

    expect(response).toEqual({ success: false, error: 'deleteNeverStarted must be true or false.' });
    expect(service.deleteWorkflow).not.toHaveBeenCalled();
  });

  it('treats a deleteNeverStarted of null as off, since a client may send null for an option it leaves out', async () => {
    const response = await commandHandlers.delete_workflow({ workflow: 'Usage budgets', deleteNeverStarted: null }, context);

    expect(service.deleteNeverStartedTasks).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      success: true,
      message: 'Deleted "Usage budgets". #12, #14 and "kangentic-mobile" #3 stay where they are, as ordinary tasks.',
    });
  });

  it('deletes a draft with its planned tasks and never looks for tasks that never started, though asked to', async () => {
    const draft = { id: 'wf-2', title: 'Usage budgets', state: 'draft' };
    service.resolveWorkflow.mockReturnValue(draft);
    service.deleteWorkflow.mockReturnValue({ workflow: draft, released: [] });

    const response = await commandHandlers.delete_workflow({ workflow: 'Usage budgets', deleteNeverStarted: true }, context);

    expect(response).toEqual({ success: true, message: 'Deleted "Usage budgets" and its planned tasks. Nothing else changed.' });
    expect(service.deleteNeverStartedTasks).not.toHaveBeenCalled();
  });

  it('says a workflow with every task done leaves them in Done', async () => {
    service.deleteWorkflow.mockReturnValue({ workflow: started, released: [] });
    service.deleteNeverStartedTasks.mockResolvedValue({ deleted: [], kept: [], failed: [] });

    const response = await commandHandlers.delete_workflow({ workflow: 'Usage budgets', deleteNeverStarted: true }, context);

    expect(service.deleteNeverStartedTasks).toHaveBeenCalledWith(expect.anything(), []);
    expect(response.message).toBe('Deleted "Usage budgets". Its tasks in Done stay in Done.');
  });
});
