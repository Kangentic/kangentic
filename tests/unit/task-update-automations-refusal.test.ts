/**
 * Unit tests for the automations switch on the TASK_UPDATE IPC handler.
 *
 * A task carries a per-task `automations_disabled` switch (see `Task` in
 * src/shared/types.ts). On a workflow task it is the task's own hold: the
 * workflow neither judges, moves nor starts it while a person works it by hand.
 * TASK_UPDATE therefore accepts the switch on a workflow task as on any other
 * (src/main/ipc/handlers/task-crud.ts), and after the write it hands the row as
 * it stood and the row as written to `applyAutomationsHoldChange`
 * (src/main/workflows/workflow-task-hold.ts), which does what the flip must do
 * for a workflow task. That module is pinned in workflow-task-hold.test.ts; here
 * it is mocked so these tests pin only what the handler passes it. The MCP task
 * tools are pinned in task-commands-automations-disabled.test.ts.
 *
 * The file keeps its original name, from when the handler refused the switch on
 * a workflow task.
 *
 * Pattern mirrors task-update-pr-resolve.test.ts: capture the function
 * registered with ipcMain.handle and invoke it directly, with every dependency
 * mocked so no Electron binary or real filesystem is needed.
 *
 * Covers:
 *   - `true` on a workflow task reaches `tasks.update` (alone and with other edits)
 *   - `false` on a workflow task reaches `tasks.update`
 *   - an edit that does not touch the switch reaches `tasks.update` for a workflow task
 *   - `true` on an ordinary task reaches `tasks.update`
 *   - the hold module gets (context, projectId, before, after) once per write, after
 *     the row holds the new value, and never for a task the repository does not know
 *   - `before` is the row as it stood right before the write, not at the top of the
 *     handler: a hold another writer sets during the branch rename's await is already
 *     in `before`, so it does not read as this write's flip
 *   - a flip from the card menu, the Workflows canvas menu or the Agent Monitor row
 *     emits `task-updated` on the board-changed bus once, after the row holds the new
 *     value, so a paired phone's re-read shows it, for a workflow task too
 *
 * Red-green: the previous handler threw the workflow reason for `true` on a
 * workflow task before it wrote anything, so each `true` test below on a workflow
 * task read red against it (the call rejected, `tasks.update` was never reached,
 * no `task-updated` was emitted). The `false` and edit-only tests pass on both
 * versions on purpose: they pin that the handler never refuses more than it
 * should. The hold-module tests read red against a handler that does not call it.
 */

import os from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {},
}));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class {},
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class {},
}));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({
  AttachmentRepository: class {},
}));

// What a branch rename does while it runs: nothing, unless a test sets a hook.
// The hook is where "another writer" lands during the rename's await.
const renameBranchBehavior = vi.hoisted(() => ({ run: null as (() => string | null) | null }));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    withLock = vi.fn(async (fn: () => Promise<unknown>) => fn());
    renameBranch = vi.fn(async () => renameBranchBehavior.run?.() ?? null);
  },
}));

const mockGetProjectRepos = vi.fn();

vi.mock('../../src/main/ipc/helpers', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: vi.fn(async () => null),
  ensureTaskBranchCheckout: vi.fn(async () => {}),
  notifySpawnBlocked: () => {},
  createTransitionEngine: vi.fn(),
  cleanupTaskResources: vi.fn(async () => {}),
  spawnAgent: vi.fn(async () => {}),
}));

vi.mock('../../src/main/pr/pr-linking', () => ({
  linkPR: vi.fn(async () => ({ status: 'unchanged', task: null })),
  autoLinkPRForTask: vi.fn(),
}));

// The hold module reaches the turn-end runner and the recovery engine; its own
// behavior is pinned in workflow-task-hold.test.ts. Called lazily, so the const
// below is initialized by the time the handler runs.
const mockApplyAutomationsHoldChange = vi.fn();
vi.mock('../../src/main/workflows/workflow-task-hold', () => ({
  applyAutomationsHoldChange: (...args: unknown[]) => mockApplyAutomationsHoldChange(...args),
}));

// ---------------------------------------------------------------------------
// Capture handlers registered by ipcMain.handle
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerTaskCrudHandlers } from '../../src/main/ipc/handlers/task-crud';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The row as it stands before the update. A workflow task is one with a `workflow_id`. */
function createExistingTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    title: 'Triage the report',
    branch_name: null,
    worktree_path: null,
    base_branch: null,
    pr_url: null,
    pr_number: null,
    pr_state: null,
    workflow_id: null,
    workflow_project_id: null,
    automations_disabled: false,
    ...overrides,
  };
}

function createMockContext(): Record<string, unknown> {
  return {
    currentProjectId: 'proj-123',
    currentProjectPath: '/mock/project',
    mainWindow: {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    },
    sessionManager: {
      listSessions: vi.fn(() => []),
      getActivityCache: vi.fn(() => ({})),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: {
      getDefaultBaseBranch: vi.fn(() => null),
      getBoardProfiles: vi.fn(() => []),
    },
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-123', path: '/mock/project' })) },
    boardEvents: { emitBoardChanged: vi.fn() },
  };
}

async function callUpdateHandler(
  input: Record<string, unknown>,
  projectId: string | null = 'proj-123',
): Promise<Record<string, unknown>> {
  const handler = capturedHandlers.get(IPC.TASK_UPDATE);
  if (!handler) throw new Error(`Handler for ${IPC.TASK_UPDATE} was not registered`);
  return await (handler(null, input, projectId) as Promise<Record<string, unknown>>);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TASK_UPDATE automations switch', () => {
  let mockTaskUpdate: ReturnType<typeof vi.fn>;

  /** Register the handler over a repository that holds `existing` (or no task at all). */
  function arrange(existing: Record<string, unknown> | undefined): void {
    mockTaskUpdate = vi.fn((patch: Record<string, unknown>) => ({ ...existing, ...patch }));
    mockGetProjectRepos.mockReturnValue({
      tasks: { getById: vi.fn(() => existing), update: mockTaskUpdate },
      swimlanes: { getById: vi.fn(() => null) },
      actions: { getTransitionsFor: vi.fn(() => []) },
      attachments: { add: vi.fn() },
    });
    registerTaskCrudHandlers(createMockContext() as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps an implementation a test installed; the hold hand-off
    // block installs one, and it must not reach the other blocks.
    mockApplyAutomationsHoldChange.mockReset();
    renameBranchBehavior.run = null;
    capturedHandlers.clear();
  });

  describe('a workflow task', () => {
    beforeEach(() => {
      arrange(createExistingTask({ workflow_id: 'workflow-1' }));
    });

    it('accepts automations_disabled: true, its own hold, and writes it', async () => {
      const result = await callUpdateHandler({ id: 'task-1', automations_disabled: true });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', automations_disabled: true }));
      expect(result).toMatchObject({ id: 'task-1', workflow_id: 'workflow-1', automations_disabled: true });
    });

    it('accepts the hold when it rides along with other edits, and writes them all', async () => {
      const result = await callUpdateHandler({ id: 'task-1', title: 'Renamed', automations_disabled: true });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-1', title: 'Renamed', automations_disabled: true }),
      );
      expect(result).toMatchObject({ title: 'Renamed', automations_disabled: true });
    });

    it('accepts automations_disabled: false, which resumes its automations', async () => {
      const result = await callUpdateHandler({ id: 'task-1', automations_disabled: false });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', automations_disabled: false }));
      expect(result).toMatchObject({ id: 'task-1', automations_disabled: false });
    });

    it('accepts an edit that leaves the switch alone', async () => {
      await callUpdateHandler({ id: 'task-1', title: 'Renamed' });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', title: 'Renamed' }));
    });
  });

  describe('an ordinary task', () => {
    beforeEach(() => {
      arrange(createExistingTask());
    });

    it('accepts automations_disabled: true and writes it', async () => {
      const result = await callUpdateHandler({ id: 'task-1', automations_disabled: true });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', automations_disabled: true }));
      expect(result).toMatchObject({ id: 'task-1', automations_disabled: true });
    });

    it('accepts automations_disabled: false and writes it', async () => {
      await callUpdateHandler({ id: 'task-1', automations_disabled: false });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', automations_disabled: false }));
    });
  });

  describe('the hold hand-off', () => {
    // The handler does not decide whether the flag changed or whether the task
    // is in a workflow: it hands over the row as it stood and the row as
    // written, and the hold module compares them. The pair must be two
    // different objects, or a handler that read the row after the write would
    // hand over a `before` that already holds the new value and the hold would
    // never see a change.
    let storedRow: Record<string, unknown>;
    let rowAtHold: Record<string, unknown> | undefined;

    beforeEach(() => {
      storedRow = createExistingTask({ workflow_id: 'workflow-1' });
      rowAtHold = undefined;
      mockTaskUpdate = vi.fn((patch: Record<string, unknown>) => {
        Object.assign(storedRow, patch);
        return { ...storedRow };
      });
      mockGetProjectRepos.mockReturnValue({
        tasks: { getById: vi.fn(() => ({ ...storedRow })), update: mockTaskUpdate },
      });
      mockApplyAutomationsHoldChange.mockImplementation(() => {
        rowAtHold = { ...storedRow };
      });
    });

    it('hands the row before and the row after the write to the hold module, once', async () => {
      const context = createMockContext();
      registerTaskCrudHandlers(context as never);

      await callUpdateHandler({ id: 'task-1', automations_disabled: true });

      expect(mockApplyAutomationsHoldChange).toHaveBeenCalledTimes(1);
      const [passedContext, projectId, before, after] = mockApplyAutomationsHoldChange.mock.calls[0];
      expect(passedContext).toBe(context);
      expect(projectId).toBe('proj-123');
      expect(before).toMatchObject({ id: 'task-1', workflow_id: 'workflow-1', automations_disabled: false });
      expect(after).toMatchObject({ id: 'task-1', workflow_id: 'workflow-1', automations_disabled: true });
    });

    it('hands over a release the same way: the held row before, the resumed row after', async () => {
      storedRow.automations_disabled = true;
      registerTaskCrudHandlers(createMockContext() as never);

      await callUpdateHandler({ id: 'task-1', automations_disabled: false });

      expect(mockApplyAutomationsHoldChange).toHaveBeenCalledTimes(1);
      const [, , before, after] = mockApplyAutomationsHoldChange.mock.calls[0];
      expect(before).toMatchObject({ automations_disabled: true });
      expect(after).toMatchObject({ automations_disabled: false });
    });

    it('applies the hold after the row holds the new value', async () => {
      registerTaskCrudHandlers(createMockContext() as never);

      await callUpdateHandler({ id: 'task-1', automations_disabled: true });

      expect(rowAtHold).toMatchObject({ automations_disabled: true });
    });

    it('hands over the row as it stood right before the write, so a hold set during the branch rename is not this write\'s flip', async () => {
      // A title change on a task with an auto-generated branch and a worktree
      // renames the branch first, and the rename awaits. The guard asks the
      // worktree path to exist (the temp folder does), no agent to be running
      // (the mock context has none) and no PR to be linked.
      storedRow.branch_name = 'triage-the-report-task-1';
      storedRow.worktree_path = os.tmpdir();
      let renames = 0;
      renameBranchBehavior.run = () => {
        renames += 1;
        // Another writer (an MCP update_task call) pauses the task meanwhile.
        storedRow.automations_disabled = true;
        return 'renamed-report-task-1';
      };
      registerTaskCrudHandlers(createMockContext() as never);

      // The call carries only the new title: it does not touch the switch.
      await callUpdateHandler({ id: 'task-1', title: 'Renamed report' });

      expect(renames).toBe(1);
      expect(mockTaskUpdate.mock.calls[0][0]).not.toHaveProperty('automations_disabled');
      expect(mockApplyAutomationsHoldChange).toHaveBeenCalledTimes(1);
      const [, , before, after] = mockApplyAutomationsHoldChange.mock.calls[0];
      // Read before the rename, `before` would say the task was free, and this
      // title edit would read as the write that paused it.
      expect(before).toMatchObject({ id: 'task-1', title: 'Triage the report', automations_disabled: true });
      expect(after).toMatchObject({ id: 'task-1', title: 'Renamed report', automations_disabled: true });
    });

    it('routes the hold by the explicit project id the call carried, not the open project', async () => {
      registerTaskCrudHandlers(createMockContext() as never);

      await callUpdateHandler({ id: 'task-1', automations_disabled: true }, 'proj-other');

      expect(mockApplyAutomationsHoldChange).toHaveBeenCalledTimes(1);
      expect(mockApplyAutomationsHoldChange.mock.calls[0][1]).toBe('proj-other');
    });
  });

  describe('a flip reaches a paired phone', () => {
    // The card's right-click menu, the Workflows canvas card's menu and the Agent
    // Monitor's row menu all write through TASK_UPDATE (the monitor stamps
    // another project when the row is not on the open board). A paired phone
    // hears it only on the board-changed bus, and re-reads the board when it
    // does, so the row must already hold the new value when the event fires.
    let storedRow: Record<string, unknown>;
    let emitBoardChanged: ReturnType<typeof vi.fn>;
    let flagAtEmit: unknown;

    beforeEach(() => {
      storedRow = createExistingTask();
      flagAtEmit = undefined;
      mockTaskUpdate = vi.fn((patch: Record<string, unknown>) => {
        Object.assign(storedRow, patch);
        return { ...storedRow };
      });
      mockGetProjectRepos.mockReturnValue({
        tasks: { getById: vi.fn(() => ({ ...storedRow })), update: mockTaskUpdate },
      });
      const context = createMockContext();
      emitBoardChanged = (context.boardEvents as { emitBoardChanged: ReturnType<typeof vi.fn> }).emitBoardChanged;
      // Recorded, not asserted, here, because the announce swallows a listener's throw.
      emitBoardChanged.mockImplementation(() => {
        flagAtEmit = storedRow.automations_disabled;
      });
      registerTaskCrudHandlers(context as never);
    });

    it.each([
      ['the card menu, on the open board', 'proj-123'],
      ['the Agent Monitor row menu, for another project', 'proj-other'],
    ])('pausing from %s emits task-updated once, after the write', async (_label, projectId) => {
      await callUpdateHandler({ id: 'task-1', automations_disabled: true }, projectId);

      expect(emitBoardChanged.mock.calls).toEqual([[{ projectId, change: 'task-updated', ids: ['task-1'] }]]);
      expect(flagAtEmit).toBe(true);
    });

    it('resuming emits too, with the cleared value already written', async () => {
      storedRow.automations_disabled = true;

      await callUpdateHandler({ id: 'task-1', automations_disabled: false });

      expect(emitBoardChanged).toHaveBeenCalledTimes(1);
      expect(flagAtEmit).toBe(false);
    });

    it('pausing a workflow task emits task-updated once, after the write, as any other task does', async () => {
      storedRow.workflow_id = 'workflow-1';

      await callUpdateHandler({ id: 'task-1', automations_disabled: true });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(emitBoardChanged.mock.calls).toEqual([[{ projectId: 'proj-123', change: 'task-updated', ids: ['task-1'] }]]);
      expect(flagAtEmit).toBe(true);
    });
  });

  describe('a task the repository does not know', () => {
    it('leaves the write to tasks.update and applies no hold, since there is no row to compare', async () => {
      arrange(undefined);

      await callUpdateHandler({ id: 'task-missing', automations_disabled: true });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-missing', automations_disabled: true }));
      expect(mockApplyAutomationsHoldChange).not.toHaveBeenCalled();
    });
  });
});
