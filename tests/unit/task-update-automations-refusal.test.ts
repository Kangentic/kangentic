/**
 * Unit tests for the automations switch on the TASK_UPDATE IPC handler.
 *
 * A task carries a per-task `automations_disabled` switch (see `Task` in
 * src/shared/types.ts). A running or paused workflow's task cannot pause its
 * automations (owner's decision, 2026-11-05): to stop work, pause the workflow.
 * So TASK_UPDATE refuses `true` on one, before it writes anything, and always
 * takes `false`, so a card left held has a way back. The MCP task tools are
 * pinned in task-commands-automations-disabled.test.ts.
 *
 * Pattern mirrors task-update-pr-resolve.test.ts: capture the function
 * registered with ipcMain.handle and invoke it directly, with every dependency
 * mocked so no Electron binary or real filesystem is needed.
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

// The task's workflow, as the refusal reads it. Called lazily, so the const below
// is initialized by the time the handler runs.
const mockWorkflowOfTask = vi.fn();
vi.mock('../../src/main/workflows/workflow-home', () => ({
  workflowOfTask: (...args: unknown[]) => mockWorkflowOfTask(...args),
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
    mockWorkflowOfTask.mockReset();
    mockWorkflowOfTask.mockReturnValue({ title: 'Usage budgets', state: 'running' });
    renameBranchBehavior.run = null;
    capturedHandlers.clear();
  });

  describe('a workflow task', () => {
    beforeEach(() => {
      arrange(createExistingTask({ workflow_id: 'workflow-1' }));
    });

    it.each(['running', 'paused'])('refuses automations_disabled: true in a %s workflow, and writes nothing', async (state) => {
      mockWorkflowOfTask.mockReturnValue({ title: 'Usage budgets', state });

      await expect(callUpdateHandler({ id: 'task-1', automations_disabled: true })).rejects.toThrow('its automations cannot be paused');

      expect(mockTaskUpdate).not.toHaveBeenCalled();
    });

    it('refuses the switch when it rides along with other edits, and writes none of them', async () => {
      await expect(callUpdateHandler({ id: 'task-1', title: 'Renamed', automations_disabled: true })).rejects.toThrow('its automations cannot be paused');

      expect(mockTaskUpdate).not.toHaveBeenCalled();
    });

    it('takes the switch once the workflow has finished: its tasks are ordinary again', async () => {
      mockWorkflowOfTask.mockReturnValue({ title: 'Usage budgets', state: 'done' });

      await callUpdateHandler({ id: 'task-1', automations_disabled: true });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    });

    it('takes the switch when the workflow is gone: a task left behind is ordinary', async () => {
      mockWorkflowOfTask.mockReturnValue(null);

      await callUpdateHandler({ id: 'task-1', automations_disabled: true });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    });

    it('accepts automations_disabled: false, so a card left held has a way back', async () => {
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
  });

  describe('a task the repository does not know', () => {
    it('leaves the write to tasks.update, since there is no row to read a workflow from', async () => {
      arrange(undefined);

      await callUpdateHandler({ id: 'task-missing', automations_disabled: true });

      expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-missing', automations_disabled: true }));
    });
  });
});
